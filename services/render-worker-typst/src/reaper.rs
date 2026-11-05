/// Dead-letter reaper — reclaims idle PEL messages via XAUTOCLAIM.
use anyhow::{Context, Result};
use redis::{aio::MultiplexedConnection, AsyncCommands, Value};
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

async fn reap_once(conn: &mut MultiplexedConnection, group: &str, consumer: &str) -> Result<()> {
    let mut cursor = "0-0".to_string();
    loop {
        let reply: Value = redis::cmd("XAUTOCLAIM")
            .arg(STREAM_KEY).arg(group).arg(consumer)
            .arg(CLAIM_IDLE_MS).arg(&cursor).arg("COUNT").arg(10)
            .query_async(conn).await.context("XAUTOCLAIM")?;

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
    let pending: Vec<Value> = redis::cmd("XPENDING")
        .arg(STREAM_KEY).arg(group).arg("-").arg("+").arg(1).arg(msg_id)
        .query_async(conn).await.context("XPENDING detail")?;

    let delivery_count = extract_delivery_count(&pending).unwrap_or(MAX_RETRIES + 1);

    if delivery_count > MAX_RETRIES {
        let mut cmd = redis::cmd("XADD");
        cmd.arg(DLQ_STREAM).arg("*")
           .arg("original_id").arg(msg_id)
           .arg("delivery_count").arg(delivery_count);
        for (k, v) in fields { cmd.arg(k).arg(v); }
        let _: String = cmd.query_async(conn).await.context("XADD to DLQ")?;
        let _: () = conn.xack(STREAM_KEY, group, &[msg_id]).await.context("XACK")?;
        warn!(msg_id, delivery_count, "message routed to DLQ");
    } else {
        info!(msg_id, delivery_count, "reclaimed for retry");
    }
    Ok(())
}

fn val_to_string(v: &Value) -> Option<String> {
    match v {
        Value::BulkString(d) => Some(String::from_utf8_lossy(d).to_string()),
        Value::SimpleString(s) => Some(s.clone()),
        _ => None,
    }
}

fn parse_autoclaim_reply(v: Value) -> Result<(String, Vec<(String, Vec<(String, String)>)>)> {
    let parts = match v {
        Value::Array(p) => p,
        _ => return Ok(("0-0".to_string(), vec![])),
    };

    let next_cursor = parts.first()
        .and_then(|x| val_to_string(x))
        .unwrap_or_else(|| "0-0".to_string());

    let mut entries = Vec::new();
    if let Some(Value::Array(msgs)) = parts.get(1) {
        for msg in msgs {
            if let Value::Array(inner) = msg {
                let id = match inner.first().and_then(|x| val_to_string(x)) {
                    Some(s) => s,
                    None => continue,
                };
                let mut fields = Vec::new();
                if let Some(Value::Array(fvs)) = inner.get(1) {
                    let mut it = fvs.iter();
                    while let (Some(k), Some(v)) = (it.next(), it.next()) {
                        if let (Some(ks), Some(vs)) = (val_to_string(k), val_to_string(v)) {
                            fields.push((ks, vs));
                        }
                    }
                }
                entries.push((id, fields));
            }
        }
    }
    Ok((next_cursor, entries))
}

fn extract_delivery_count(pending: &[Value]) -> Option<i64> {
    if let Some(Value::Array(entry)) = pending.first() {
        if let Some(Value::Int(count)) = entry.get(3) {
            return Some(*count);
        }
    }
    None
}
