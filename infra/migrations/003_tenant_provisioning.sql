-- Migration 003: Tenant provisioning helpers and seed data for local dev
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- Helper function: register a new tenant and return the raw API key.
-- The raw key is returned ONCE and never stored in plaintext.
-- Callers must securely transmit it to the tenant out-of-band.
CREATE OR REPLACE FUNCTION provision_tenant(
    p_name           VARCHAR(255),
    p_max_concurrency INT DEFAULT 10
) RETURNS TABLE(tenant_id UUID, raw_api_key TEXT) AS $$
DECLARE
    v_tenant_id  UUID    := gen_random_uuid();
    v_raw_key    TEXT    := encode(gen_random_bytes(32), 'hex');
    v_key_hash   VARCHAR := encode(digest(v_raw_key, 'sha256'), 'hex');
BEGIN
    INSERT INTO tenants (tenant_id, name, api_key_hash, max_concurrency)
    VALUES (v_tenant_id, p_name, v_key_hash, p_max_concurrency);

    RETURN QUERY SELECT v_tenant_id, v_raw_key;
END;
$$ LANGUAGE plpgsql;

-- Helper function: register a webhook endpoint for a tenant.
-- The raw secret is returned once for the caller to configure their receiver.
CREATE OR REPLACE FUNCTION register_webhook(
    p_tenant_id UUID,
    p_url       TEXT,
    p_events    TEXT[] DEFAULT ARRAY['job.completed', 'job.failed']
) RETURNS TABLE(endpoint_id UUID, raw_secret TEXT) AS $$
DECLARE
    v_endpoint_id UUID := gen_random_uuid();
    v_raw_secret  TEXT := encode(gen_random_bytes(32), 'hex');
BEGIN
    INSERT INTO webhook_endpoints (endpoint_id, tenant_id, url, secret_hash, events)
    VALUES (v_endpoint_id, p_tenant_id, p_url, v_raw_secret, p_events);

    RETURN QUERY SELECT v_endpoint_id, v_raw_secret;
END;
$$ LANGUAGE plpgsql;

-- ── Dev seed data ─────────────────────────────────────────────────────────────
-- Insert a known dev tenant with a fixed API key hash for local testing.
-- Raw key: "dev-api-key-for-local-testing"
-- Hash: sha256("dev-api-key-for-local-testing")
INSERT INTO tenants (
    tenant_id,
    name,
    api_key_hash,
    max_concurrency
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Dev Tenant',
    encode(digest('dev-api-key-for-local-testing', 'sha256'), 'hex'),
    50
) ON CONFLICT (tenant_id) DO NOTHING;

-- Insert a dev template for measurement_book using Typst engine
INSERT INTO document_templates (
    template_id,
    tenant_id,
    name,
    version,
    engine_type,
    template_source,
    schema_definition
) VALUES (
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'measurement_book',
    1,
    'typst',
    '-- loaded from /templates/typst/measurement_book.typ --',
    '{}'::jsonb
) ON CONFLICT (tenant_id, name, version) DO NOTHING;

COMMIT;
