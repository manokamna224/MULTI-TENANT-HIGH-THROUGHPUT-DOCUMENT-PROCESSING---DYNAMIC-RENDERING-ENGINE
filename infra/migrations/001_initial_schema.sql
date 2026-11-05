-- Migration 001: Initial Schema
-- Applies to: PostgreSQL 15+
-- Run with: psql $DATABASE_URL -f 001_initial_schema.sql
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- trigram search on template names

-- ── Tenant Isolation & Configuration ─────────────────────────────────────────
CREATE TABLE tenants (
    tenant_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             VARCHAR(255) NOT NULL,
    -- bcrypt or Argon2id hash of the raw API key — never store plaintext
    api_key_hash     VARCHAR(64)  NOT NULL,
    max_concurrency  INT          NOT NULL DEFAULT 10,
    -- Per-tenant RSA/ECDSA certificate path or KMS key ARN for signing
    signing_key_ref  TEXT,
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_tenants_api_key_hash ON tenants(api_key_hash);

-- ── Template Registry (Versioned) ────────────────────────────────────────────
CREATE TABLE document_templates (
    template_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID         NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name              VARCHAR(100) NOT NULL,
    version           INT          NOT NULL DEFAULT 1,
    engine_type       VARCHAR(20)  NOT NULL
                        CHECK (engine_type IN ('typst', 'chromium')),
    -- Typst markup or HTML/Jinja/Handlebars source
    template_source   TEXT         NOT NULL,
    -- JSON Schema that the incoming payload must satisfy before rendering
    schema_definition JSONB        NOT NULL,
    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name, version)
);

CREATE INDEX idx_templates_tenant ON document_templates(tenant_id);

-- ── Render Jobs & Audit Trail ─────────────────────────────────────────────────
CREATE TABLE render_jobs (
    job_id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID         NOT NULL REFERENCES tenants(tenant_id),
    template_id       UUID         REFERENCES document_templates(template_id),
    document_type     VARCHAR(50)  NOT NULL,
    status            VARCHAR(20)  NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    -- Full JSON payload stored for audit; consider partitioning this table by month
    input_payload     JSONB        NOT NULL,
    -- SHA-256 of rendered PDF bytes (pre-signature) for integrity verification
    computed_checksum VARCHAR(64),
    -- s3://bucket/key or equivalent
    storage_path      TEXT,
    execution_time_ms INT,
    retry_count       SMALLINT     NOT NULL DEFAULT 0,
    error_log         TEXT,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ
);

-- Partial index: fast lookup of pending work without scanning completed rows
CREATE INDEX idx_render_jobs_pending
    ON render_jobs(created_at)
    WHERE status IN ('queued', 'processing');

CREATE INDEX idx_render_jobs_tenant_status
    ON render_jobs(tenant_id, status, created_at DESC);

-- ── Digital Signature Audit Log ───────────────────────────────────────────────
CREATE TABLE signature_records (
    sig_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID        NOT NULL REFERENCES render_jobs(job_id),
    tenant_id       UUID        NOT NULL REFERENCES tenants(tenant_id),
    signer_cn       TEXT        NOT NULL,
    certificate_sn  TEXT        NOT NULL,  -- hex serial number
    digest_algo     VARCHAR(20) NOT NULL DEFAULT 'SHA-256',
    document_hash   VARCHAR(64) NOT NULL,  -- hex SHA-256 of pre-signature PDF
    signed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- DER bytes of the PKCS#7 envelope stored for offline re-verification
    pkcs7_der       BYTEA
);

CREATE INDEX idx_sig_records_job ON signature_records(job_id);

-- ── Webhook Endpoints (Notification Engine) ───────────────────────────────────
CREATE TABLE webhook_endpoints (
    endpoint_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    url          TEXT        NOT NULL,
    -- HMAC-SHA256 secret for signing outbound webhook payloads
    secret_hash  TEXT        NOT NULL,
    events       TEXT[]      NOT NULL DEFAULT ARRAY['job.completed', 'job.failed'],
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── updated_at trigger (applied to tenants) ───────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
