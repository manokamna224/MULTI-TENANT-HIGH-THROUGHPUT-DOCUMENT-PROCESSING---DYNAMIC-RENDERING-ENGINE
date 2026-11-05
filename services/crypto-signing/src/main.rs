mod config;
mod db;
mod manifest;
mod pipeline;
mod signer;
mod linearizer;
mod storage;

use anyhow::Result;
use tracing::info;
use tracing_subscriber::{fmt, EnvFilter};
use tracing_subscriber::prelude::*;

/// Entry point.
///
/// Consumes from the `render:results` Redis Stream (consumer group
/// `signing-workers`). For each completed render job it:
///   1. Downloads the unsigned PDF from S3
///   2. Linearizes it (Fast Web View)
///   3. Embeds the tamper-evident QR manifest
///   4. Injects a PKCS#7 detached signature
///   5. Re-uploads the signed PDF (overwrites the unsigned artifact)
///   6. XACKs the stream message
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(EnvFilter::from_default_env())
        .with(fmt::layer().json())
        .init();

    let cfg = config::Config::from_env()?;
    info!(
        redis_url  = %cfg.redis_url,
        key_source = ?cfg.key_source,
        "crypto-signing service starting"
    );

    let worker = pipeline::SigningWorker::new(cfg).await?;
    worker.run().await
}
