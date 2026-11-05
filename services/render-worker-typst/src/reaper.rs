/// Dead-letter reaper task.
///
/// Runs every REAP_INTERVAL seconds. Calls XAUTOCLAIM to reclaim messages
/// idle in the PEL longer than CLAIM_IDLE_MS, retries up to MAX_RETRIES,
/// then routes to render:dlq and ACKs the original.
use anyhow::{Context, Result};
use redis::{aio::MultiplexedConnection, AsyncCommands};
use std::time::Duration;
use tokio::time;
use tracing::{error, info, warn};

const STREAM_KEY:    &str = "render:jobs";
const DLQ_STREAM:    &str = "render:dlq";
const CLAIM_IDLE_MS: u64  = 60_000;
const MAX_RETRIES:   i64  = 3;
const REAP_INTERVAL: u64  = 30;

pub async fn run_reaper(
    mut conn: MultiplexedConnection,
    consumer_group: String,
    consumer_name: String,
) {
    let mut interval = time::interval(Duration::from_secs(REAP_INTERVAL));
    loop {
        interval.tick().await;
        if let Err(e) = reap_once(&mut conn, &consumer_group, &consumer_name).await {
            error!(error = %e, "reaper cycle failed");
        }
    }
}

async fn reap_once(
    conn: &mut MultiplexedConnection,
    group: &str,
    consumer: &str,
) -> Result<()> {
    let mut cursor = "0-0".to_string();
    loop {
        let reply: redis::Value = redis::cmd("XAUTOCLAIM")
            .arg(STREAM_KEY)
            .arg(group)
            .arg(consumer)
            .arg(CLAIM_IDLE_MS)
            .arg(&cursor)
            .arg("COUNT").arg(10)
            .query_async(conn)
            .await
            .context("XAUTOCLAIM")?;

        let (next_cursor, entries) = parse_autoclaim_reply(reply)?;
        for (msg_id, fields) in entries {
            handle_claimed(conn, group, &msg_id, &fields).await?;
        }
        cursor = next_cursor;
        if cursor == "0-0" { break; }
    }
    Ok(())
}

async fn handle_claimed(
    conn: &mut MultiplexedConnection,
    group: &str,
    msg_id: &str,
    fields: &[(String, String)],
) -> Result<()> {
    // XPENDING <stream> <group> - + 1 <consumer>
    let pending: Vec<redis::Value> = redis::cmd("XPENDING")
        .arg(STREAM_KEY)
        .arg(group)
        .arg("-").arg("+").arg(1)
        .arg(msg_id)
        .query_async(conn)
        .await
        .context("XPENDING detail")?;

    let delivery_count = extract_delivery_count(&pending).unwrap_or(MAX_RETRIES + 1);

    if delivery_count > MAX_RETRIES {
        let mut cmd = redis::cmd("XADD");
        cmd.arg(DLQ_STREAM)
           .arg("*")
           .arg("original_id").arg(msg_id)
           .arg("delivery_count").arg(delivery_count);
        for (k, v) in fields { cmd.arg(k).arg(v); }
        let _: String = cmd.query_async(conn).await.context("XADD to DLQ")?;

        let _: () = conn
            .xack(STREAM_KEY, group, &[msg_id])
            .await
            .context("XACK after DLQ routing")?;

        warn!(msg_id, delivery_count, "message routed to dead-letter queue");
    } else {
        info!(msg_id, delivery_count, "reclaimed for retry");
    }
    Ok(())
}

/// Parse the XAUTOCLAIM reply — format changed in redis-rs 0.27.
/// Returns (next-cursor, Vec<(msg_id, Vec<(key, value)>)>).
fn parse_autoclaim_reply(v: redis::Value) -> Result<(String, Vec<(String, Vec<(String, String)>)>)> {
    use redis::Value::*;
    let parts = match v {
        Array(p) | Bulk(p) => p,
        _ => return Ok(("0-0".to_string(), vec![])),
    };

    let next_cursor = match parts.first() {
        Some(BulkString(d)) | Some(SimpleString(d)) => {
            String::from_utf8_lossy(d).to_string()
        }
        _ => "0-0".to_string(),
    };

    let mut entries = Vec::new();
    let msgs_val = parts.get(1);
    let msgs = match msgs_val {
        Some(Array(m)) | Some(Bulk(m)) => m,
        _ => return Ok((next_cursor, entries)),
    };

    for msg in msgs {
        let inner = match msg {
            Array(i) | Bulk(i) => i,
            _ => continue,
        };
        let id = match inner.first() {
            Some(BulkString(d)) | Some(SimpleString(d)) => String::from_utf8_lossy(d).to_string(),
            _ => continue,
        };
        let mut fields = Vec::new();
        if let Some(Array(fvs)) | Some(Bulk(fvs)) = inner.get(1) {
            let mut it = fvs.iter();
            while let (Some(k), Some(v)) = (it.next(), it.next()) {
                let ks = match k {
                    BulkString(d) | SimpleString(d) => String::from_utf8_lossy(d).to_string(),
                    _ => continue,
                };
                let vs = match v {
                    BulkString(d) | SimpleString(d) => String::from_utf8_lossy(d).to_string(),
                    _ => String::new(),
                };
                fields.push((ks, vs));
            }
        }
        entries.push((id, fields));
    }
    Ok((next_cursor, entries))
}

fn extract_delivery_count(pending: &[redis::Value]) -> Option<i64> {
    use redis::Value::*;
    if let Some(Array(entry)) | Some(Bulk(entry)) = pending.first() {
        if let Some(Int(count)) = entry.get(3) {
            return Some(*count);
        }
    }
    None
}
