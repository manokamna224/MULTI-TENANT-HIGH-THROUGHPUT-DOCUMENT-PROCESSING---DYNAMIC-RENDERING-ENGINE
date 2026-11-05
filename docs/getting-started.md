# Getting Started — Local Development

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Docker Desktop | 4.x+ | Container runtime |
| Go | 1.22+ | Build ingestion-engine |
| Rust + Cargo | 1.81+ | Build Typst worker + crypto-signing |
| Node.js | 22+ | Build api-gateway, chromium worker, artifact-storage |
| Typst CLI | 0.11+ | PDF rendering (installed inside Docker) |
| qpdf | any | PDF linearization (installed inside Docker) |
| k6 | 0.53+ | Load testing |
| OpenSSL | 3.x | Dev cert generation |

## 1. Generate dev certificates

```bash
make gen-certs
```

Creates `dev-certs/signing.crt`, `signing.key`, and `signing.p12`.
These are gitignored — never commit private keys.

## 2. Start the full stack

```bash
make dev
```

Starts: Postgres, Redis, MinIO, all six application services.

| Endpoint | URL |
|---|---|
| API Gateway | http://localhost:3000 |
| Ingestion Engine (direct) | http://localhost:8080 |
| MinIO Console | http://localhost:9001 |
| PostgreSQL | localhost:5432 |

## 3. Send a test render request

```bash
make smoke
```

Or manually:
```bash
curl -X POST http://localhost:3000/v1/render \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-api-key-for-local-testing" \
  -d @docs/sample-payload.json
```

Expected response:
```json
{ "job_id": "<uuid>", "status": "queued" }
```

## 4. Check job status

```bash
curl http://localhost:3000/v1/jobs/<job_id> \
  -H "X-API-Key: dev-api-key-for-local-testing"
```

## 5. Find the rendered PDF

Open the MinIO console at http://localhost:9001 and browse:
`docengine-artifacts/<tenant_id>/measurement_book/<year>/<month>/<job_id>.pdf`

## 6. Run unit tests

```bash
make test-go    # Go arithmetic verifier + schema validator
make test-rust  # Rust unit tests
```

## 7. Run load test

With the stack running:
```bash
make test-load
```

Runs the three k6 scenarios (smoke → ramp → sustained 100 VU).
Results are written to `tests/load/load-test-results.json`.

## Environment Variables Reference

See `infra/docker/docker-compose.yml` for the full set.
Key variables per service:

### ingestion-engine
| Var | Default | Description |
|---|---|---|
| `REDIS_URL` | — | Redis connection URL |
| `DATABASE_URL` | — | PostgreSQL DSN |
| `PORT` | 8080 | Listen port |
| `GIN_MODE` | debug | `debug` or `release` |

### render-worker-typst
| Var | Default | Description |
|---|---|---|
| `REDIS_URL` | — | Redis URL |
| `CONSUMER_GROUP` | typst-workers | Stream consumer group |
| `WORKER_CONCURRENCY` | 4 | Parallel renders per pod |
| `TEMPLATE_DIR` | /templates/typst | Mounted template directory |

### crypto-signing
| Var | Default | Description |
|---|---|---|
| `SIGNING_KEY_SOURCE` | pem | `pem`, `pkcs12`, or `kms` |
| `SIGNING_CERT_PATH` | — | Path to PEM cert |
| `SIGNING_KEY_PATH` | — | Path to PEM private key |
| `KMS_KEY_ARN` | — | AWS KMS key ARN (Phase 3) |

## Stream Topology

```
render:jobs     — ingestion-engine → typst/chromium workers
render:results  — typst/chromium workers → crypto-signing + artifact-storage
signed:results  — crypto-signing → artifact-storage
render:dlq      — dead-letter for exhausted retries
```
