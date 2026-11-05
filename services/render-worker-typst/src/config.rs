use anyhow::{Context, Result};

/// Runtime configuration loaded from environment variables.
#[derive(Debug, Clone)]
pub struct Config {
    pub redis_url: String,
    /// Redis Streams consumer group name.
    pub consumer_group: String,
    /// Unique consumer name per worker instance (should include pod name in k8s).
    pub consumer_name: String,
    /// Maximum simultaneous render goroutines per worker process.
    pub concurrency: usize,
    /// S3-compatible bucket for rendered PDF artifacts.
    pub artifact_bucket: String,
    /// Optional S3 endpoint override (for MinIO / LocalStack).
    pub s3_endpoint: Option<String>,
    /// Directory where Typst template files are mounted.
    pub template_dir: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            redis_url: env("REDIS_URL")?,
            consumer_group: env_or("CONSUMER_GROUP", "typst-workers"),
            consumer_name: env_or("CONSUMER_NAME", &format!("worker-{}", uuid::Uuid::new_v4())),
            concurrency: env_or("WORKER_CONCURRENCY", "4").parse().context("WORKER_CONCURRENCY must be an integer")?,
            artifact_bucket: env_or("ARTIFACT_BUCKET", "docengine-artifacts"),
            s3_endpoint: std::env::var("S3_ENDPOINT").ok(),
            template_dir: env_or("TEMPLATE_DIR", "/templates/typst"),
        })
    }
}

fn env(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("required env var {key} not set"))
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}
