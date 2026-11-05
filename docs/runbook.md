# DocEngine — Production Runbook

## Service map

| Service | Port | Health check |
|---|---|---|
| api-gateway | 3000 | `GET /healthz` |
| ingestion-engine | 8080 | `GET /v1/healthz` |
| render-worker-typst | — (stream consumer) | `pgrep render-worker-typst` |
| render-worker-chromium | — (stream consumer) | `pgrep node` |
| crypto-signing | — (stream consumer) | `pgrep crypto-signing` |
| artifact-storage | — (stream consumer) | `pgrep node` |

## Redis Stream topology

| Stream | Producer | Consumer group | Purpose |
|---|---|---|---|
| `render:jobs` | ingestion-engine | `typst-workers`, `chromium-workers` | Job queue |
| `render:results` | render workers | `signing-workers`, `notification-workers` | Completed renders |
| `signed:results` | crypto-signing | `notification-workers` | Signed PDFs |
| `render:dlq` | reapers | (manual review) | Dead-letter queue |

---

## Runbook procedures

### Check stream health

```bash
# Pending message counts per group
redis-cli XPENDING render:jobs typst-workers - + 10
redis-cli XPENDING render:jobs chromium-workers - + 10

# Stream length (all messages, not just pending)
redis-cli XLEN render:jobs
redis-cli XLEN render:dlq   # should stay near 0

# Consumer group info
redis-cli XINFO GROUPS render:jobs
```

### Check job pipeline status

```bash
# Jobs stuck in 'queued' for > 5 minutes
psql $DATABASE_URL -c "
  SELECT job_id, document_type, created_at,
         NOW() - created_at AS age
  FROM render_jobs
  WHERE status = 'queued'
    AND created_at < NOW() - INTERVAL '5 minutes'
  ORDER BY created_at
  LIMIT 20;"

# Error distribution in last hour
psql $DATABASE_URL -c "
  SELECT status, document_type, COUNT(*), MAX(retry_count)
  FROM render_jobs
  WHERE created_at > NOW() - INTERVAL '1 hour'
  GROUP BY 1, 2
  ORDER BY 1, 3 DESC;"
```

### Manual DLQ inspection and replay

```bash
# See what's in the DLQ
redis-cli XRANGE render:dlq - + COUNT 5

# Replay a DLQ message back to render:jobs
# 1. Get the payload field from the DLQ entry
# 2. XADD it back to render:jobs
redis-cli XADD render:jobs '*' payload '<json>'

# Clear the DLQ after investigation
redis-cli XTRIM render:dlq MAXLEN 0
```

### Scale workers manually (k8s)

```bash
# Typst workers — scale up to handle backlog
kubectl scale deployment render-worker-typst --replicas=10 -n docengine

# Check KEDA scaler status
kubectl get scaledobject -n docengine
kubectl describe scaledobject typst-worker-scaler -n docengine
```

### Force-complete a stuck job

```bash
psql $DATABASE_URL -c "
  UPDATE render_jobs
  SET status = 'failed',
      error_log = 'manually failed by ops',
      completed_at = NOW()
  WHERE job_id = '<uuid>'
    AND status = 'queued';"
```

### Rotate a tenant API key

```bash
# 1. Generate new key via helper function
psql $DATABASE_URL -c "SELECT * FROM provision_tenant_key('<tenant_id>');"

# 2. Update api_key_hash for the tenant
psql $DATABASE_URL -c "
  UPDATE tenants
  SET api_key_hash = encode(digest('<new_raw_key>', 'sha256'), 'hex')
  WHERE tenant_id = '<tenant_id>';"

# 3. Deliver the new raw key to the tenant out-of-band
# 4. Verify old key no longer works:
curl -I https://api.yourorg.com/v1/healthz -H 'X-API-Key: <old_key>'
# Expect: HTTP 401
```

### Investigate a specific job end-to-end

```bash
JOB_ID="<uuid>"

# DB state
psql $DATABASE_URL -c "SELECT * FROM render_jobs WHERE job_id='$JOB_ID';"
psql $DATABASE_URL -c "SELECT * FROM signature_records WHERE job_id='$JOB_ID';"

# Was it published to stream?
redis-cli XRANGE render:jobs - + COUNT 1000 | grep -A2 "$JOB_ID"

# Is the PDF in S3?
aws s3 ls s3://docengine-artifacts/ --recursive | grep "$JOB_ID"

# Check pod logs (k8s)
kubectl logs -n docengine -l app=render-worker-typst --since=1h | grep "$JOB_ID"
kubectl logs -n docengine -l app=crypto-signing      --since=1h | grep "$JOB_ID"
```

### Memory alert on Chromium workers

The Chromium worker recycles browsers at 250 MB RSS. If pods are OOMKilled (limit 1 GB):

```bash
# Check current RSS
kubectl top pods -n docengine -l app=render-worker-chromium

# Reduce concurrency to decrease peak memory
kubectl set env deployment/render-worker-chromium \
  WORKER_CONCURRENCY=1 MAX_RSS_MB=200 -n docengine

# Or reduce max jobs before recycle (more frequent recycling)
kubectl set env deployment/render-worker-chromium \
  MAX_JOBS_PER_WORKER=25 -n docengine
```

### Certificate rotation (signing)

```bash
# 1. Generate new cert/key pair
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout new-signing.key -out new-signing.crt \
  -subj "/CN=docengine-signer-v2"

# 2. Export as PKCS#12
openssl pkcs12 -export \
  -in new-signing.crt -inkey new-signing.key \
  -out new-signing.p12 -passout pass:$NEW_PASS

# 3. Update k8s secret
kubectl create secret generic docengine-signing-certs \
  --from-file=signing.p12=new-signing.p12 \
  --from-literal=p12-passphrase=$NEW_PASS \
  --dry-run=client -o yaml | kubectl apply -n docengine -f -

# 4. Restart signing workers to pick up new secret
kubectl rollout restart deployment/crypto-signing -n docengine
kubectl rollout status  deployment/crypto-signing -n docengine
```

---

## SLO targets (Phase 4)

| Metric | Target |
|---|---|
| API p95 latency | < 2 s |
| API p99 latency | < 5 s |
| Error rate | < 1% |
| Typst render p95 | < 150 ms |
| Chromium render p95 | < 3 s |
| DLQ growth rate | 0 new entries / hour (steady state) |
| PDF availability after render | < 5 s |

## Alerting thresholds (recommended)

| Alert | Condition | Severity |
|---|---|---|
| High DLQ depth | `XLEN render:dlq > 10` | Warning |
| Stuck jobs | `queued jobs older than 10m > 5` | Critical |
| High error rate | `HTTP 5xx > 2% over 5m` | Critical |
| Worker OOMKilled | Pod restart count > 3 in 10m | Critical |
| Stream lag | `pending messages > 500 per group` | Warning |
| Cert expiry | cert expires in < 30 days | Warning |
