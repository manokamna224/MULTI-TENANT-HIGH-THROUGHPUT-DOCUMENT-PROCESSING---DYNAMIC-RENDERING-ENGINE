/// Worker pool that drains the Redis Stream render:jobs consumer group.
///
/// Per-job lifecycle:
///   1. XREADGROUP  — claim the next message from render:jobs
///   2. Deserialise RenderJob from the payload field
///   3. TypstRenderer::render() → raw PDF bytes
///   4. SHA-256 the PDF bytes for tamper-evidence
///   5. ArtifactStorage::upload_pdf() → s3://bucket/key
///   6. DbClient::mark_completed() — update render_jobs row in Postgres
///   7. XACK — remove from PEL
///   8. publish_result() — push to render:results for downstream consumers
///
/// On any error the message stays in the PEL; the dead-letter reaper retries
/// it up to MAX_RETRIES before routing to render:dlq.
use anyhow::{Context, Result};
use redis::{
    aio::MultiplexedConnection,
    streams::{StreamReadOptions, StreamReadReply},
    AsyncCommands, Client,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::{
    config::Config,
    db::DbClient,
    job::{JobResult, JobStatus, RenderJob},
    renderer::TypstRenderer,
    storage::ArtifactStorage,
};

const STREAM_KEY:    &str = "render:jobs";
const RESULT_STREAM: &str = "render:results";
const BLOCK_MS:      u64  = 2_000;

pub struct WorkerPool {
    cfg:      Arc<Config>,
    renderer: Arc<TypstRenderer>,
    storage:  Arc<ArtifactStorage>,
    redis:    Client,
}

impl WorkerPool {
    pub async fn new(cfg: Config) -> Result<Self> {
        let redis = Client::open(cfg.redis_url.clone()).context("opening redis client")?;

        // Ensure the consumer group exists (MKSTREAM creates stream if absent).
        // BUSYGROUP is expected when restarting — ignore it.
        let mut conn = redis
            .get_multiplexed_tokio_connection()
            .await
            .context("initial redis connect")?;

        let _: redis::RedisResult<()> = redis::cmd("XGROUP")
            .arg("CREATE")
            .arg(STREAM_KEY)
            .arg(&cfg.consumer_group)
            .arg("$")
            .arg("MKSTREAM")
            .query_async(&mut conn)
            .await;

        let renderer = Arc::new(TypstRenderer::new(&cfg.template_dir));
        let storage  = Arc::new(
            ArtifactStorage::new(cfg.artifact_bucket.clone(), cfg.s3_endpoint.clone())
                .await
                .context("initialising artifact storage")?,
        );

        Ok(Self { cfg: Arc::new(cfg), renderer, storage, redis })
    }

    /// Spawn `concurrency` worker tasks and block until SIGINT/SIGTERM.
    pub async fn run(self) -> Result<()> {
        info!(concurrency = self.cfg.concurrency, "starting typst worker pool");

        let handles: Vec<JoinHandle<()>> = (0..self.cfg.concurrency)
            .map(|i| {
                let cfg      = Arc::clone(&self.cfg);
                let renderer = Arc::clone(&self.renderer);
                let storage  = Arc::clone(&self.storage);
                let redis    = self.redis.clone();
                let consumer = format!("{}-{i}", cfg.consumer_name);

                tokio::spawn(async move {
                    if let Err(e) = run_worker(cfg, renderer, storage, redis, consumer).await {
                        error!(error = %e, "worker task exited with error");
                    }
                })
            })
            .collect();

        tokio::signal::ctrl_c().await.ok();
        info!("shutdown signal received — stopping workers");
        for h in handles { h.abort(); }
        Ok(())
    }
}

async fn run_worker(
    cfg:      Arc<Config>,
    renderer: Arc<TypstRenderer>,
    storage:  Arc<ArtifactStorage>,
    redis:    Client,
    consumer: String,
) -> Result<()> {
    let mut conn = redis
        .get_multiplexed_tokio_connection()
        .await
        .context("worker redis connect")?;

    // Optional DB client — worker degrades gracefully if DATABASE_URL is absent.
    let db = DbClient::from_env().await?;

    info!(consumer = %consumer, "typst worker ready");

    loop {
        let opts = StreamReadOptions::default()
            .group(&cfg.consumer_group, &consumer)
            .count(1)
            .block(BLOCK_MS as usize);

        let reply: StreamReadReply = conn
            .xread_options(&[STREAM_KEY], &[">"], &opts)
            .await
            .context("XREADGROUP")?;

        for stream in reply.keys {
            for entry in stream.ids {
                let msg_id = entry.id.clone();

                let payload_str = entry
                    .map
                    .get("payload")
                    .and_then(|v| match v {
                        redis::Value::BulkString(d) => Some(String::from_utf8_lossy(d).to_string()),
                        redis::Value::SimpleString(s) => Some(s.clone()),
                        _ => None,
                    })
                    .unwrap_or_default();

                match process_job(&payload_str, Arc::clone(&renderer), Arc::clone(&storage)).await {
                    Ok(result) => {
                        // 1. Update DB
                        if let Some(ref db_client) = db {
                            if let Some(ref path) = result.storage_path {
                                let checksum = result.computed_checksum.as_deref().unwrap_or("");
                                if let Err(e) = db_client
                                    .mark_completed(&result.job_id, path, checksum, result.execution_time_ms)
                                    .await
                                {
                                    warn!(job_id = %result.job_id, error = %e, "DB update failed — continuing");
                                }
                            }
                        }

                        // 2. ACK the stream message
                        let _: () = conn
                            .xack(STREAM_KEY, &cfg.consumer_group, &[&msg_id])
                            .await
                            .context("XACK")?;

                        // 3. Publish to render:results
                        publish_result(&mut conn, RESULT_STREAM, &result).await?;

                        info!(
                            job_id = %result.job_id,
                            elapsed_ms = result.execution_time_ms,
                            "job completed"
                        );
                    }
                    Err(e) => {
                        warn!(msg_id = %msg_id, error = %e, "job failed — left in PEL for reaper");

                        // Attempt to record the failure in DB (best effort)
                        // We must parse the job_id from the raw payload to do so.
                        if let Some(ref db_client) = db {
                            if let Ok(job) = serde_json::from_str::<RenderJob>(&payload_str) {
                                let _ = db_client.mark_failed(&job.job_id, &e.to_string()).await;
                            }
                        }
                    }
                }
            }
        }
    }
}

async fn process_job(
    payload_str: &str,
    renderer:    Arc<TypstRenderer>,
    storage:     Arc<ArtifactStorage>,
) -> Result<JobResult> {
    let job: RenderJob = serde_json::from_str(payload_str)
        .context("deserialising job")?;

    let start = std::time::Instant::now();

    let (pdf_bytes, _elapsed) = renderer
        .render(&job.document_type, &job.payload.to_string())
        .await
        .context("rendering PDF")?;

    // SHA-256 the raw bytes before upload
    let checksum = hex::encode(Sha256::digest(&pdf_bytes));

    let storage_path = storage
        .upload_pdf(&job.tenant_id, &job.document_type, &job.job_id, pdf_bytes)
        .await
        .context("uploading PDF")?;

    Ok(JobResult {
        job_id:            job.job_id,
        tenant_id:         job.tenant_id,
        document_type:     job.document_type,
        status:            JobStatus::Completed,
        storage_path:      Some(storage_path),
        computed_checksum: Some(checksum),
        execution_time_ms: start.elapsed().as_millis() as u64,
        error_log:         None,
    })
}

async fn publish_result(
    conn:   &mut MultiplexedConnection,
    stream: &str,
    result: &JobResult,
) -> Result<()> {
    let data = serde_json::to_string(result).context("serialising result")?;
    let _: String = conn
        .xadd(stream, "*", &[("result", data)])
        .await
        .context("XADD render:results")?;
    Ok(())
}
