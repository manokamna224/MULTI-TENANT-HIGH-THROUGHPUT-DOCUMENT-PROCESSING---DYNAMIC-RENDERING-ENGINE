# DocEngine — Architecture Reference

## Complete Pipeline Data-Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CLIENT / ERP API                                   │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │  POST /v1/render  (JSON payload)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     API GATEWAY  (Fastify · Node 22)                        │
│  ① HMAC/JWT tenant auth  →  tenant_id resolved                              │
│  ② Per-tenant rate limit (Redis sliding window)                             │
│  ③ X-Tenant-ID injected  →  reverse proxy to ingestion-engine               │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │  HTTP → ingestion-engine:8080
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│               INGESTION & VALIDATION ENGINE  (Go 1.22 · Gin)                │
│                                                                              │
│  ① JSON Schema validation  (santhosh-tekuri/jsonschema embedded FS)         │
│  ② Decimal arithmetic reconciliation  (shopspring/decimal)                  │
│     • Quantity × Rate = Amount  for every line item                         │
│     • sum(amounts) = summary.subtotal                                       │
│     • previous_cumulative + current_claim ≤ contract_value                 │
│  → 422 with error coordinates on failure  e.g. line_items[4].amount_mismatch│
│                                                                              │
│  ③ INSERT render_jobs (status='queued')  →  Postgres                        │
│  ④ XADD render:jobs  →  Redis Stream (MAXLEN 100k)                          │
│  ⑤ RetrySweeper: re-publishes stuck 'queued' rows every 30s                 │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │  render:jobs  Redis Stream
                       ┌────────────┴──────────────┐
                       ▼                           ▼
      ┌────────────────────────┐    ┌──────────────────────────┐
      │  TYPST WORKER POOL     │    │  CHROMIUM WORKER POOL    │
      │  (Rust · tokio)        │    │  (Node 22 · Puppeteer)   │
      │                        │    │                          │
      │ XREADGROUP consumer    │    │ XREADGROUP consumer      │
      │  group: typst-workers  │    │  group: chromium-workers │
      │                        │    │                          │
      │ ① typst compile →      │    │ ① BrowserPool.acquire()  │
      │   subprocess (isolated)│    │ ② Handlebars template    │
      │ ② SHA-256 checksum     │    │ ③ page.pdf() A4          │
      │ ③ S3 upload (AES-256)  │    │ ④ SHA-256 checksum       │
      │ ④ DB mark_completed    │    │ ⑤ S3 upload (AES-256)    │
      │ ⑤ XACK + XADD result  │    │ ⑥ DB mark_completed      │
      │                        │    │ ⑦ XACK + XADD result     │
      │ DlqReaper (XAUTOCLAIM) │    │ DlqReaper (XAUTOCLAIM)   │
      │  → render:dlq after 3  │    │  → render:dlq after 3    │
      │    failed deliveries   │    │    failed deliveries     │
      └────────────┬───────────┘    └──────────────┬───────────┘
                   └────────────┬──────────────────┘
                                │  render:results  Redis Stream
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              CRYPTO-SIGNING SERVICE  (Rust · tokio)                         │
│                                                                              │
│  XREADGROUP consumer group: signing-workers                                 │
│                                                                              │
│  ① Download unsigned PDF from S3                                            │
│  ② qpdf --linearize  →  Fast Web View (progressive download)                │
│  ③ DocumentManifest:  SHA-256 + metadata → QR code PNG                      │
│  ④ CMS_sign (OpenSSL)  →  PKCS#7 detached signature (DER)                  │
│  ⑤ Re-upload linearized PDF to S3 (same key, atomic overwrite)              │
│  ⑥ INSERT signature_records  →  Postgres audit trail                        │
│  ⑦ XACK + XADD signed:results                                               │
│                                                                              │
│  Key sources:  PEM file → PKCS#12 → AWS KMS (Phase 3)                      │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │  signed:results  Redis Stream
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│           ARTIFACT-STORAGE / NOTIFICATION SERVICE  (Node 22)                │
│                                                                              │
│  XREADGROUP consumer group: notification-workers                             │
│  Listens on both signed:results and render:results                          │
│                                                                              │
│  ① Query webhook_endpoints WHERE tenant_id AND event = ANY(events)          │
│  ② S3 getSignedUrlPromise()  →  ephemeral presigned GET URL (1h TTL)        │
│  ③ POST to each endpoint with:                                               │
│     X-DocEngine-Signature: sha256=<HMAC-SHA256 of body>                     │
│     Retry: 3 attempts, exponential backoff (1s · 2s · 4s)                  │
│  ④ XACK                                                                     │
│                                                                              │
│  Webhook payload includes: job_id, storage_path, download_url,              │
│  sha256, signed_at, execution_time_ms                                        │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌───────────────────────────────────┐
                    │         STORAGE LAYER              │
                    │                                   │
                    │  PostgreSQL 16                    │
                    │  ├── tenants                      │
                    │  ├── document_templates (versioned)│
                    │  ├── render_jobs (partitioned)    │
                    │  ├── signature_records            │
                    │  └── webhook_endpoints            │
                    │                                   │
                    │  S3-compatible Object Storage     │
                    │  └── <tenant>/<type>/<y>/<m>/<id>.pdf│
                    │      (AES-256 SSE at rest)        │
                    │                                   │
                    │  Redis 7 (Streams + rate-limit)   │
                    │  ├── render:jobs                  │
                    │  ├── render:results               │
                    │  ├── signed:results               │
                    │  └── render:dlq                   │
                    └───────────────────────────────────┘
```

## Service Map

| Service | Language | RAM budget | Key libraries |
|---|---|---|---|
| `api-gateway` | TypeScript / Node 22 | 128 MB | Fastify, @fastify/rate-limit, ioredis, jsonwebtoken |
| `ingestion-engine` | Go 1.22 | 64 MB | gin, shopspring/decimal, pgx/v5, go-redis |
| `render-worker-typst` | Rust 2021 | 30–60 MB/worker | tokio, redis-rs, tokio-postgres, aws-sdk-s3 |
| `render-worker-chromium` | TypeScript / Node 22 | 400 MB/pool | puppeteer-core, @sparticuz/chromium, ioredis, pg |
| `crypto-signing` | Rust 2021 | 64 MB | tokio, openssl (vendored), redis-rs, tokio-postgres |
| `artifact-storage` | TypeScript / Node 22 | 64 MB | ioredis, axios, aws-sdk, pg |

## Implementation Phases

| Phase | Status | Scope |
|---|---|---|
| **Phase 1** — Deterministic Math + CLI Prototype | ✅ Complete | Go decimal engine, JSON Schema validation, Typst template rendering |
| **Phase 2** — Worker Daemon + Job Queue | ✅ Complete | Redis Streams consumer groups, XACK, dead-letter reaper (XAUTOCLAIM), DB callbacks |
| **Phase 3** — Cryptographic + Multi-Tenant Security | ✅ Complete | PKCS#7 signing, signature_records audit trail, linearization, QR manifest, HMAC webhooks |
| **Phase 4** — Production Hardening | ✅ Complete | k6 load tests, HPA + KEDA scaling, mem limits, retry sweeper, benchmarking |

## Key Design Decisions

**Why Typst over Puppeteer for tables?**
Typst compiles natively to PDF without a DOM, JavaScript engine, or font rasterization overhead. For tabular financial documents (100+ page measurement books) it uses 15–30 MB RAM vs 100–300 MB per Chromium tab, and handles repeating table headers and page-break-aware running totals without JavaScript hacks.

**Why subprocess for Typst instead of linking the crate?**
Subprocess isolation gives a hard RSS ceiling via Linux cgroups, prevents any Typst panic from killing the worker process, and enables trivial binary upgrades. The fork overhead (~2 ms) is well within the 150 ms render budget.

**Why decimal strings in JSON payloads?**
IEEE-754 float64 cannot represent 0.10 exactly. All monetary values arrive as strings (`"18.75"`) and are parsed into `shopspring/decimal` / `rust_decimal` inside the engine, eliminating representation error at the boundary before any arithmetic begins.

**Why Redis Streams over SQS/RabbitMQ?**
Redis Streams support consumer groups with at-least-once delivery (PEL + XACK), XAUTOCLAIM for dead-letter reclaim, and millisecond enqueue latency — all without an external broker. The same Redis instance handles per-tenant rate limiting via sorted-set sliding windows.

**How is duplicate delivery handled?**
Workers ACK only after S3 upload succeeds. A duplicate delivery re-renders and re-uploads to the same S3 key (idempotent overwrite). The DB `UPDATE` is conditional (`WHERE job_id = $1`) so it's also safe to run twice.
