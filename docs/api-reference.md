# DocEngine — API Reference

Base URL: `http://api-gateway:3000` (local dev) / `https://api.yourorg.com` (prod)

All requests require authentication via one of:
- `Authorization: Bearer <jwt>` — HS256 JWT with `{ tenant_id, exp }` payload
- `X-API-Key: <raw-key>` — hashed against the `tenants.api_key_hash` column

---

## POST /v1/render

Submit a document for rendering. The request is validated, arithmetically verified (for financial document types), persisted, and enqueued atomically.

### Request

```http
POST /v1/render
Content-Type: application/json
X-API-Key: dev-api-key-for-local-testing
```

```json
{
  "tenant_id":     "00000000-0000-0000-0000-000000000001",
  "template_id":   "00000000-0000-0000-0000-000000000002",
  "document_type": "measurement_book",
  "payload": { ... }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `tenant_id` | UUID | ✓ | Tenant identifier |
| `template_id` | UUID | ✓ | Template version to render with |
| `document_type` | string | ✓ | `measurement_book` · `schedule_of_rates` · `cumulative_billing` · custom |
| `payload` | object | ✓ | Document data matching the registered JSON Schema |

### Validation pipeline

For `measurement_book`, `schedule_of_rates`, `cumulative_billing`:

1. **JSON Schema** — validates structure, required fields, string patterns
2. **Decimal arithmetic** — for each line item: `quantity × rate = amount` (base-10, no float drift)
3. **Subtotal check** — `sum(amounts) = summary.subtotal`
4. **Cumulative billing** — `previous_cumulative + current_claim ≤ contract_value`

Validation failures are rejected at the boundary and **never enqueued**.

### Response — 202 Accepted

```json
{
  "job_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "queued"
}
```

### Error responses

| Status | `error` field | When |
|---|---|---|
| 400 | `invalid_request` | Missing required fields or invalid UUID |
| 401 | `unauthorized` | Missing or invalid auth credential |
| 422 | `schema_validation_failed` | JSON Schema violation |
| 422 | `arithmetic_reconciliation_failed` | Line-item amount mismatch; includes `details[]` with coordinates e.g. `line_items[4].amount_mismatch` |
| 422 | `subtotal_mismatch` | `sum(line_items.amount) ≠ summary.subtotal` |
| 422 | `cumulative_billing_exceeded` | `previous + current > contract_value` |
| 429 | `rate_limit_exceeded` | Per-tenant rate limit hit |
| 500 | `database_unavailable` | Postgres write failed |

---

## GET /v1/jobs/:id

Poll status of a specific render job.

### Response — 200

```json
{
  "job_id":            "3fa85f64-...",
  "tenant_id":         "00000000-...",
  "template_id":       "00000000-...",
  "document_type":     "measurement_book",
  "status":            "completed",
  "storage_path":      "s3://docengine-artifacts/tenant-id/measurement_book/2026/11/job-id.pdf",
  "computed_checksum": "a3f2bc...",
  "execution_time_ms": 142,
  "retry_count":       0,
  "created_at":        "2026-11-04T08:23:11Z",
  "completed_at":      "2026-11-04T08:23:12Z"
}
```

**Status values:** `queued` → `processing` → `completed` | `failed`

| Status | 404 | job_id not found |

---

## GET /v1/jobs

List jobs for the authenticated tenant. Paginated, newest first.

### Query parameters

| Param | Default | Max | Description |
|---|---|---|---|
| `limit` | 20 | 100 | Page size |
| `offset` | 0 | — | Skip N jobs |
| `tenant_id` | from auth header | — | Required when calling ingestion-engine directly |

### Response — 200

```json
{
  "jobs":   [ { ...JobRow }, ... ],
  "limit":  20,
  "offset": 0,
  "count":  5
}
```

---

## GET /v1/healthz

Liveness probe. No auth required.

```json
{ "status": "ok", "service": "ingestion-engine" }
```

---

## Webhook notifications

When a job completes or fails, DocEngine POSTs to all active webhook endpoints
registered for the tenant.

### Payload

```json
{
  "event":         "job.completed",
  "job_id":        "3fa85f64-...",
  "tenant_id":     "00000000-...",
  "document_type": "measurement_book",
  "storage_path":  "s3://...",
  "download_url":  "https://s3.amazonaws.com/...?X-Amz-Expires=3600&...",
  "sha256":        "a3f2bc...",
  "signed_at":     "2026-11-04T08:23:12Z",
  "timestamp":     "2026-11-04T08:23:13Z"
}
```

| Event | When |
|---|---|
| `job.completed` | PDF rendered, signed, and uploaded successfully |
| `job.failed` | All retries exhausted; `error_log` field present |

### Signature verification

Every outbound webhook request carries:
```
X-DocEngine-Signature: sha256=<hex>
X-DocEngine-Attempt: 1
```

Verify with:
```python
import hmac, hashlib
expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
assert hmac.compare_digest(f"sha256={expected}", received_signature)
```

The `download_url` is an S3 presigned GET URL valid for `PRESIGN_TTL_SEC` seconds (default 3600).

---

## Payload schemas

### measurement_book

```jsonc
{
  "document_meta": {
    "title":            "string (max 200)",
    "contract_no":      "string (max 50)",
    "contractor":       "string (max 200)",
    "work_description": "string (max 500)",
    "date":             "YYYY-MM-DD"
  },
  "line_items": [
    {
      "index":       0,          // integer, 0-based
      "description": "string",
      "unit":        "cum",
      "quantity":    "120.50",   // decimal string — no float
      "rate":        "85.00",    // decimal string
      "amount":      "10242.50"  // must equal quantity × rate (2 d.p., banker's rounding)
    }
  ],
  "summary": {
    "subtotal":            "10242.50",  // must equal sum(line_items.amount)
    "tax_rate_pct":        18,          // number 0–100
    "tax_amount":          "1843.65",
    "grand_total":         "12086.15",
    "contract_value":      "500000.00",
    "previous_cumulative": "0.00",
    "current_claim":       "12086.15"   // previous + current_claim ≤ contract_value
  }
}
```

### schedule_of_rates

```jsonc
{
  "document_meta": { "title": "string", "financial_year": "2026-27" },
  "sections": [
    {
      "name": "Earthwork",
      "items": [
        { "code": "EW-001", "description": "string", "unit": "cum", "rate": "85.00" }
      ]
    }
  ]
}
```

### cumulative_billing

Identical to `measurement_book` with the addition of `document_meta.bill_no` (integer).
