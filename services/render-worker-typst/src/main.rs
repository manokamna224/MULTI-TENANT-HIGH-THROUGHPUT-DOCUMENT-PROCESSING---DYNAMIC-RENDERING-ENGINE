mod config;
mod db;
mod job;
mod reaper;
mod renderer;
mod storage;
mod worker;

use anyhow::Result;
use tracing::info;
use tracing_subscriber::{fmt, EnvFilter};
use tracing_subscriber::prelude::*;

#[tokio::main]
async fn main() -> Result<()> {
    // Structured JSON logging — compatible with CloudWatch / Datadog
    tracing_subscriber::registry()
        .with(EnvFilter::from_default_env())
        .with(fmt::layer().json())
        .init();

    let cfg = config::Config::from_env()?;
    info!(redis_url = %cfg.redis_url, concurrency = cfg.concurrency, "typst render worker starting");

    // Spawn dead-letter reaper as a background task
    let reaper_client = redis::Client::open(cfg.redis_url.clone())?;
    let reaper_conn = reaper_client
        .get_multiplexed_tokio_connection()
        .await?;
    let reaper_group = cfg.consumer_group.clone();
    let reaper_consumer = format!("reaper-{}", cfg.consumer_name);
    tokio::spawn(reaper::run_reaper(reaper_conn, reaper_group, reaper_consumer));

    let pool = worker::WorkerPool::new(cfg).await?;
    pool.run().await?;

    Ok(())
}
