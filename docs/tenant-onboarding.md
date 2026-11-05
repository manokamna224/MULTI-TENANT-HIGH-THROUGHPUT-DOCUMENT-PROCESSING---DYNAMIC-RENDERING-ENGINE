# Tenant Onboarding Guide

This guide covers provisioning a new tenant, registering templates, setting up webhook delivery, and verifying the end-to-end pipeline.

---

## 1. Provision the tenant

Connect to the database and call the `provision_tenant` helper function.
The raw API key is returned **once** — store it in your secrets manager immediately.

```sql
-- Returns: (tenant_id UUID, raw_api_key TEXT)
SELECT * FROM provision_tenant('Acme Corp', 20);
```

```
              tenant_id               |            raw_api_key
--------------------------------------+--------------------------------------------
 3e7f2a1b-0000-0000-0000-000000000099 | a3f9e2c1...64hexchars
```

Deliver the raw API key to the tenant out-of-band (email, 1Password, etc.).
It is **not stored in plaintext** — you cannot retrieve it later.

---

## 2. Register document templates

Insert one row per template version. The `template_source` column holds the
full Typst markup (for the `typst` engine) or HTML/Handlebars source (for `chromium`).

```sql
INSERT INTO document_templates
  (tenant_id, name, version, engine_type, template_source, schema_definition)
VALUES (
  '3e7f2a1b-0000-0000-0000-000000000099',
  'measurement_book',
  1,
  'typst',
  '-- paste Typst source or reference a mounted file --',
  '{}'::jsonb
);
```

Or use the API to register templates programmatically:

```bash
# Future: POST /v1/templates  (Phase 5)
# For now, insert directly via SQL.
```

---

## 3. Set per-tenant concurrency limit

The `max_concurrency` column controls how many jobs this tenant can have
in-flight simultaneously via the Redis token bucket (Phase 3).

```sql
UPDATE tenants
SET max_concurrency = 5
WHERE tenant_id = '3e7f2a1b-0000-0000-0000-000000000099';
```

---

## 4. Register a webhook endpoint

```sql
-- Returns: (endpoint_id UUID, raw_secret TEXT)
SELECT * FROM register_webhook(
  '3e7f2a1b-0000-0000-0000-000000000099',
  'https://erp.acme.com/webhooks/docengine',
  ARRAY['job.completed', 'job.failed']
);
```

The tenant must verify the HMAC-SHA256 signature on every inbound webhook:

```python
import hmac, hashlib

def verify_signature(body: bytes, received_sig: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(
        secret.encode(), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, received_sig)
```

---

## 5. Verify authentication

```bash
# Using API key
curl -s https://api.yourorg.com/v1/healthz \
  -H "X-API-Key: <raw_api_key>" | jq .
# Expected: { "status": "ok" }

# Using JWT (generate with shared secret or per-tenant RS256)
TOKEN=$(python3 -c "
import jwt, time
print(jwt.encode(
  {'tenant_id': '3e7f2a1b-...', 'exp': int(time.time()) + 3600},
  '<JWT_SECRET>', algorithm='HS256'
))
")
curl -s https://api.yourorg.com/v1/healthz \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 6. Submit a test render job

```bash
curl -s -X POST https://api.yourorg.com/v1/render \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <raw_api_key>" \
  -d '{
    "tenant_id":     "3e7f2a1b-0000-0000-0000-000000000099",
    "template_id":   "<template_id_from_step_2>",
    "document_type": "measurement_book",
    "payload": {
      "document_meta": {
        "title": "Test MB", "contract_no": "CT-001",
        "contractor": "Test Co", "work_description": "Excavation",
        "date": "2026-11-04"
      },
      "line_items": [
        {"index":0,"description":"Earthwork","unit":"cum",
         "quantity":"10.00","rate":"100.00","amount":"1000.00"}
      ],
      "summary": {
        "subtotal":"1000.00","tax_rate_pct":18,
        "tax_amount":"180.00","grand_total":"1180.00",
        "contract_value":"50000.00","previous_cumulative":"0.00",
        "current_claim":"1180.00"
      }
    }
  }' | jq .
```

Expected response:

```json
{ "job_id": "xxxxxxxx-...", "status": "queued" }
```

---

## 7. Poll for completion

```bash
curl -s https://api.yourorg.com/v1/jobs/<job_id> \
  -H "X-API-Key: <raw_api_key>" | jq '{status, storage_path, execution_time_ms}'
```

When `status` is `completed`, `storage_path` contains the S3 URI.
The webhook endpoint will also receive a `job.completed` event with a
time-limited `download_url` (valid for 1 hour by default).

---

## 8. Rotate the API key

```sql
-- Generate a fresh key
UPDATE tenants
SET api_key_hash = encode(digest('<new_raw_key>', 'sha256'), 'hex')
WHERE tenant_id = '3e7f2a1b-0000-0000-0000-000000000099';
```

Deliver the new key to the tenant and revoke the old one by confirming the
update has taken effect (test the old key returns 401).

---

## 9. Offboard / suspend a tenant

```sql
-- Soft-suspend (auth returns 403, no data deleted)
UPDATE tenants SET is_active = FALSE
WHERE tenant_id = '3e7f2a1b-0000-0000-0000-000000000099';

-- Hard delete (cascades to templates and webhooks; does NOT delete render_jobs or artifacts)
DELETE FROM tenants WHERE tenant_id = '3e7f2a1b-0000-0000-0000-000000000099';
```

To delete S3 artifacts:
```bash
aws s3 rm s3://docengine-artifacts/3e7f2a1b-0000-0000-0000-000000000099/ --recursive
```
