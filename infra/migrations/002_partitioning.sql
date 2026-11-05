-- Migration 002: Partition render_jobs by month for long-term scalability.
-- Requires PostgreSQL 13+ native partitioning.
-- ─────────────────────────────────────────────────────────────────────────────
-- CAUTION: This migration converts render_jobs to a partitioned table.
-- Run during a maintenance window; it recreates the table.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Rename existing table
ALTER TABLE render_jobs RENAME TO render_jobs_old;

-- Create partitioned parent (identical columns, PARTITION BY RANGE on created_at)
CREATE TABLE render_jobs (
    job_id            UUID        NOT NULL DEFAULT gen_random_uuid(),
    tenant_id         UUID        NOT NULL REFERENCES tenants(tenant_id),
    template_id       UUID        REFERENCES document_templates(template_id),
    document_type     VARCHAR(50) NOT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    input_payload     JSONB       NOT NULL,
    computed_checksum VARCHAR(64),
    storage_path      TEXT,
    execution_time_ms INT,
    retry_count       SMALLINT    NOT NULL DEFAULT 0,
    error_log         TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ,
    PRIMARY KEY (job_id, created_at)
) PARTITION BY RANGE (created_at);

-- Create monthly partitions for the current and next 12 months
-- (In production, use pg_partman for automated partition creation)
DO $$
DECLARE
    start_date DATE := DATE_TRUNC('month', NOW());
    i INT;
BEGIN
    FOR i IN 0..11 LOOP
        DECLARE
            p_start DATE := start_date + (i || ' months')::INTERVAL;
            p_end   DATE := p_start + '1 month'::INTERVAL;
            p_name  TEXT := 'render_jobs_' || TO_CHAR(p_start, 'YYYY_MM');
        BEGIN
            EXECUTE format(
                'CREATE TABLE IF NOT EXISTS %I PARTITION OF render_jobs
                 FOR VALUES FROM (%L) TO (%L)',
                p_name, p_start, p_end
            );
        END;
    END LOOP;
END;
$$;

-- Migrate existing rows
INSERT INTO render_jobs SELECT * FROM render_jobs_old;

-- Recreate indexes on the partitioned table
CREATE INDEX idx_rj_pending ON render_jobs(created_at) WHERE status IN ('queued', 'processing');
CREATE INDEX idx_rj_tenant  ON render_jobs(tenant_id, status, created_at DESC);

DROP TABLE render_jobs_old;

COMMIT;
