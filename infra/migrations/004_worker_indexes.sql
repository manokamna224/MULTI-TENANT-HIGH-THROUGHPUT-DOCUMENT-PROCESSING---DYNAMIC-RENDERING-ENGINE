-- Migration 004: Additional indexes for worker DB callbacks and query patterns.
-- Safe to run on a live database — all operations are non-blocking (CONCURRENTLY).
BEGIN;

-- Workers look up render_jobs by job_id to update status.
-- The existing PRIMARY KEY covers this, but an expression index on
-- (job_id) WHERE status = 'queued' speeds up the retry sweeper's poll.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rj_queued_created
    ON render_jobs (created_at ASC)
    WHERE status = 'queued';

-- Signing worker joins signature_records → render_jobs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sig_tenant_signed
    ON signature_records (tenant_id, signed_at DESC);

-- Notification worker queries webhook_endpoints per tenant + event
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhooks_tenant_active
    ON webhook_endpoints (tenant_id)
    WHERE is_active = TRUE;

-- Template lookup by engine_type for routing (typst vs chromium workers)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_templates_engine
    ON document_templates (engine_type)
    WHERE is_active = TRUE;

COMMIT;
