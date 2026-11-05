/// Minimal PostgreSQL client for the render worker.
///
/// The worker needs to update render_jobs status after completing a job
/// so the ingestion-engine's `GET /v1/jobs/:id` reflects the real state.
/// We use tokio-postgres directly (no ORM, no pgxpool) — a single connection
/// per worker task is sufficient at this concurrency level.
use anyhow::{Context, Result};
use std::env;
use tokio_postgres::{Client, NoTls};
use tracing::debug;

/// DbClient wraps a single tokio-postgres connection.
pub struct DbClient {
    client: Client,
}

impl DbClient {
    /// Connect to Postgres using the DATABASE_URL environment variable.
    /// Returns Ok(None) if DATABASE_URL is not set — DB updates are optional.
    pub async fn from_env() -> Result<Option<Self>> {
        let url = match env::var("DATABASE_URL") {
            Ok(u) => u,
            Err(_) => {
                tracing::warn!("DATABASE_URL not set — job status will not be updated in DB");
                return Ok(None);
            }
        };

        let (client, conn) = tokio_postgres::connect(&url, NoTls)
            .await
            .context("connecting to postgres")?;

        // Drive the connection in a background task
        tokio::spawn(async move {
            if let Err(e) = conn.await {
                tracing::error!(error = %e, "postgres connection error");
            }
        });

        Ok(Some(Self { client }))
    }

    /// Mark a render_jobs row as completed.
    pub async fn mark_completed(
        &self,
        job_id: &str,
        storage_path: &str,
        checksum: &str,
        exec_ms: u64,
    ) -> Result<()> {
        self.client
            .execute(
                "UPDATE render_jobs SET
                    status            = 'completed',
                    storage_path      = $2,
                    computed_checksum = $3,
                    execution_time_ms = $4,
                    completed_at      = NOW()
                 WHERE job_id = $1",
                &[&job_id, &storage_path, &checksum, &(exec_ms as i32)],
            )
            .await
            .context("updating job to completed")?;
        debug!(job_id, "DB row marked completed");
        Ok(())
    }

    /// Mark a render_jobs row as failed and increment retry_count.
    pub async fn mark_failed(&self, job_id: &str, error: &str) -> Result<()> {
        self.client
            .execute(
                "UPDATE render_jobs SET
                    status       = 'failed',
                    error_log    = $2,
                    retry_count  = retry_count + 1,
                    completed_at = NOW()
                 WHERE job_id = $1",
                &[&job_id, &error],
            )
            .await
            .context("updating job to failed")?;
        debug!(job_id, "DB row marked failed");
        Ok(())
    }
}
