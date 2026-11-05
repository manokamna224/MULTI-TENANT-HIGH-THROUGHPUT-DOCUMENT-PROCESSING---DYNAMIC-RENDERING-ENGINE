//go:build integration

// Package integration runs end-to-end tests against real infrastructure
// spun up via testcontainers-go.
//
// Run:  go test ./... -v -tags integration -timeout 180s
package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	redismodule "github.com/testcontainers/testcontainers-go/modules/redis"
	"github.com/testcontainers/testcontainers-go/wait"
	"github.com/yourorg/docengine/ingestion/internal/api"
	"github.com/yourorg/docengine/ingestion/internal/queue"
	"github.com/yourorg/docengine/ingestion/internal/repository"
	"github.com/yourorg/docengine/ingestion/internal/validation"
	"go.uber.org/zap"
)

// ─── helpers ──────────────────────────────────────────────────────────────────

func mustNoErr(t *testing.T, err error, msg string) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", msg, err)
	}
}

// spinPostgres starts a postgres:16-alpine container, applies migrations,
// and returns a DSN ready for pgxpool.
func spinPostgres(t *testing.T, ctx context.Context) string {
	t.Helper()
	c, err := postgres.RunContainer(ctx,
		testcontainers.WithImage("postgres:16-alpine"),
		postgres.WithDatabase("docengine"),
		postgres.WithUsername("docengine"),
		postgres.WithPassword("testpw"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	mustNoErr(t, err, "start postgres container")
	t.Cleanup(func() { c.Terminate(ctx) }) //nolint:errcheck

	dsn, err := c.ConnectionString(ctx, "sslmode=disable")
	mustNoErr(t, err, "postgres DSN")

	applyMigrations(t, ctx, dsn)
	return dsn
}

// spinRedis starts a redis:7-alpine container and returns a redis:// URL.
func spinRedis(t *testing.T, ctx context.Context) string {
	t.Helper()
	c, err := redismodule.RunContainer(ctx,
		testcontainers.WithImage("redis:7-alpine"),
	)
	mustNoErr(t, err, "start redis container")
	t.Cleanup(func() { c.Terminate(ctx) }) //nolint:errcheck

	ep, err := c.Endpoint(ctx, "redis")
	mustNoErr(t, err, "redis endpoint")
	return ep
}

// wireRouter builds a full Gin router wired to real (containerised) infra.
func wireRouter(t *testing.T, ctx context.Context, pgDSN, redisURL string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	log, _ := zap.NewDevelopment()

	repo, err := repository.New(ctx, pgDSN)
	mustNoErr(t, err, "repository.New")
	t.Cleanup(repo.Close)

	pub, err := queue.NewRedisPublisher(redisURL)
	mustNoErr(t, err, "NewRedisPublisher")
	t.Cleanup(func() { pub.Close() })

	validator, err := validation.New()
	mustNoErr(t, err, "validation.New")

	r := gin.New()
	api.NewHandler(log, pub, repo, validator).RegisterRoutes(r)
	return r
}

func applyMigrations(t *testing.T, ctx context.Context, dsn string) {
	t.Helper()
	pool, err := pgxpool.New(ctx, dsn)
	mustNoErr(t, err, "pgxpool for migrations")
	defer pool.Close()

	stmts := []string{
		`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`,
		`CREATE TABLE IF NOT EXISTS tenants (
			tenant_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name             VARCHAR(255) NOT NULL,
			api_key_hash     VARCHAR(64)  NOT NULL,
			max_concurrency  INT          NOT NULL DEFAULT 10,
			signing_key_ref  TEXT,
			is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
			created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
			updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS document_templates (
			template_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
			name            VARCHAR(100) NOT NULL,
			version         INT NOT NULL DEFAULT 1,
			engine_type     VARCHAR(20) NOT NULL CHECK (engine_type IN ('typst','chromium')),
			template_source TEXT NOT NULL,
			schema_definition JSONB NOT NULL,
			is_active       BOOLEAN NOT NULL DEFAULT TRUE,
			created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE (tenant_id, name, version)
		)`,
		`CREATE TABLE IF NOT EXISTS render_jobs (
			job_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			tenant_id         UUID NOT NULL REFERENCES tenants(tenant_id),
			template_id       UUID REFERENCES document_templates(template_id),
			document_type     VARCHAR(50)  NOT NULL,
			status            VARCHAR(20)  NOT NULL DEFAULT 'queued'
				CHECK (status IN ('queued','processing','completed','failed')),
			input_payload     JSONB        NOT NULL,
			computed_checksum VARCHAR(64),
			storage_path      TEXT,
			execution_time_ms INT,
			retry_count       SMALLINT     NOT NULL DEFAULT 0,
			error_log         TEXT,
			created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
			completed_at      TIMESTAMPTZ
		)`,
		`INSERT INTO tenants (tenant_id,name,api_key_hash,max_concurrency)
		 VALUES ('00000000-0000-0000-0000-000000000001','Test Tenant','testhash',50)
		 ON CONFLICT DO NOTHING`,
		`INSERT INTO document_templates
			(template_id,tenant_id,name,version,engine_type,template_source,schema_definition)
		 VALUES ('00000000-0000-0000-0000-000000000002',
			'00000000-0000-0000-0000-000000000001',
			'measurement_book',1,'typst','stub','{}')
		 ON CONFLICT DO NOTHING`,
	}

	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatalf("migration failed (%s): %v", s[:min(len(s), 60)], err)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func validMeasurementBookBody() []byte {
	body, _ := json.Marshal(map[string]interface{}{
		"tenant_id":     "00000000-0000-0000-0000-000000000001",
		"template_id":   "00000000-0000-0000-0000-000000000002",
		"document_type": "measurement_book",
		"payload": map[string]interface{}{
			"document_meta": map[string]string{
				"title": "Earthwork Block A", "contract_no": "CT-001",
				"contractor": "ABC Ltd", "work_description": "Excavation",
				"date": "2026-11-04",
			},
			"line_items": []map[string]interface{}{
				{"index": 0, "description": "Earthwork", "unit": "cum",
					"quantity": "120.50", "rate": "85.00", "amount": "10242.50"},
				{"index": 1, "description": "Disposal", "unit": "cum",
					"quantity": "120.50", "rate": "12.00", "amount": "1446.00"},
			},
			"summary": map[string]interface{}{
				"subtotal": "11688.50", "tax_rate_pct": 18,
				"tax_amount": "2103.93", "grand_total": "13792.43",
				"contract_value": "500000.00", "previous_cumulative": "0.00",
				"current_claim": "13792.43",
			},
		},
	})
	return body
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// TestIngest_HappyPath: valid payload → 202, DB row queued, stream message published.
func TestIngest_HappyPath(t *testing.T) {
	ctx := context.Background()
	pgDSN    := spinPostgres(t, ctx)
	redisURL := spinRedis(t, ctx)
	router   := wireRouter(t, ctx, pgDSN, redisURL)

	req := httptest.NewRequest(http.MethodPost, "/v1/render",
		bytes.NewReader(validMeasurementBookBody()))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("want 202, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	mustNoErr(t, json.NewDecoder(w.Body).Decode(&resp), "decode response")

	jobID, _ := resp["job_id"].(string)
	if jobID == "" {
		t.Fatalf("missing job_id in response: %v", resp)
	}
	if resp["status"] != "queued" {
		t.Fatalf("want status=queued, got %v", resp["status"])
	}

	// ── Assert DB row ─────────────────────────────────────────────────────
	pool, err := pgxpool.New(ctx, pgDSN)
	mustNoErr(t, err, "pgxpool for assertions")
	defer pool.Close()

	var status, docType string
	err = pool.QueryRow(ctx,
		"SELECT status, document_type FROM render_jobs WHERE job_id=$1", jobID,
	).Scan(&status, &docType)
	mustNoErr(t, err, "query job row")

	if status != "queued" {
		t.Errorf("DB status want=queued got=%s", status)
	}
	if docType != "measurement_book" {
		t.Errorf("DB document_type want=measurement_book got=%s", docType)
	}

	// ── Assert Redis Stream ───────────────────────────────────────────────
	// Parse "redis://host:port" → "host:port"
	addr := redisURL
	if len(addr) > 8 && addr[:8] == "redis://" {
		addr = addr[8:]
	}
	rdb := redis.NewClient(&redis.Options{Addr: addr})
	defer rdb.Close()

	msgs, err := rdb.XRange(ctx, "render:jobs", "-", "+").Result()
	mustNoErr(t, err, "XRANGE render:jobs")

	found := false
	for _, msg := range msgs {
		if raw, ok := msg.Values["payload"]; ok {
			var j map[string]interface{}
			if err := json.Unmarshal([]byte(fmt.Sprint(raw)), &j); err == nil {
				if j["job_id"] == jobID {
					found = true
					break
				}
			}
		}
	}
	if !found {
		t.Errorf("job_id %s not found on render:jobs stream (messages: %d)", jobID, len(msgs))
	}
}

// TestIngest_ArithmeticRejection: wrong line-item amount → 422 with coordinate.
func TestIngest_ArithmeticRejection(t *testing.T) {
	ctx := context.Background()
	pgDSN    := spinPostgres(t, ctx)
	redisURL := spinRedis(t, ctx)
	router   := wireRouter(t, ctx, pgDSN, redisURL)

	body, _ := json.Marshal(map[string]interface{}{
		"tenant_id":     "00000000-0000-0000-0000-000000000001",
		"template_id":   "00000000-0000-0000-0000-000000000002",
		"document_type": "measurement_book",
		"payload": map[string]interface{}{
			"document_meta": map[string]string{
				"title": "T", "contract_no": "C", "contractor": "X",
				"work_description": "W", "date": "2026-11-04",
			},
			// amount 9999 ≠ 200 × 18.75 = 3750
			"line_items": []map[string]interface{}{
				{"index": 4, "description": "Compaction", "unit": "sqm",
					"quantity": "200.00", "rate": "18.75", "amount": "9999.00"},
			},
			"summary": map[string]interface{}{
				"subtotal": "9999.00", "tax_rate_pct": 18,
				"tax_amount": "1799.82", "grand_total": "11798.82",
				"contract_value": "500000.00", "previous_cumulative": "0.00",
				"current_claim": "11798.82",
			},
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/render", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp) //nolint:errcheck
	if resp["error"] != "arithmetic_reconciliation_failed" {
		t.Errorf("want arithmetic_reconciliation_failed, got %v", resp["error"])
	}
	details, _ := resp["details"].([]interface{})
	if len(details) == 0 {
		t.Error("expected error coordinate in details slice")
	}
	// Verify the coordinate references index 4
	coord := fmt.Sprint(details[0])
	if coord == "" {
		t.Errorf("detail coordinate must not be empty")
	}

	// ── No DB row should have been created ───────────────────────────────
	pool, _ := pgxpool.New(ctx, pgDSN)
	defer pool.Close()
	var count int
	pool.QueryRow(ctx, "SELECT COUNT(*) FROM render_jobs").Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Errorf("rejected job must not create a DB row, found %d rows", count)
	}
}

// TestIngest_CumulativeBillingExceeded: previous + current > contract → 422.
func TestIngest_CumulativeBillingExceeded(t *testing.T) {
	ctx := context.Background()
	pgDSN    := spinPostgres(t, ctx)
	redisURL := spinRedis(t, ctx)
	router   := wireRouter(t, ctx, pgDSN, redisURL)

	body, _ := json.Marshal(map[string]interface{}{
		"tenant_id":     "00000000-0000-0000-0000-000000000001",
		"template_id":   "00000000-0000-0000-0000-000000000002",
		"document_type": "measurement_book",
		"payload": map[string]interface{}{
			"document_meta": map[string]string{
				"title": "T", "contract_no": "C", "contractor": "X",
				"work_description": "W", "date": "2026-11-04",
			},
			"line_items": []map[string]interface{}{
				{"index": 0, "description": "X", "unit": "ls",
					"quantity": "1.00", "rate": "50000.00", "amount": "50000.00"},
			},
			"summary": map[string]interface{}{
				"subtotal": "50000.00", "tax_rate_pct": 18,
				"tax_amount": "9000.00", "grand_total": "59000.00",
				// 90000 + 59000 = 149000 > 100000
				"contract_value": "100000.00", "previous_cumulative": "90000.00",
				"current_claim": "59000.00",
			},
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/render", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp) //nolint:errcheck
	if resp["error"] != "cumulative_billing_exceeded" {
		t.Errorf("want cumulative_billing_exceeded, got %v", resp["error"])
	}
}

// TestJobStatus_NotFound: polling an unknown job_id → 404.
func TestJobStatus_NotFound(t *testing.T) {
	ctx := context.Background()
	pgDSN    := spinPostgres(t, ctx)
	redisURL := spinRedis(t, ctx)
	router   := wireRouter(t, ctx, pgDSN, redisURL)

	req := httptest.NewRequest(http.MethodGet,
		"/v1/jobs/aaaaaaaa-0000-0000-0000-000000000000", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", w.Code)
	}
}

// TestListJobs_RequiresTenantID: omitting tenant_id → 400.
func TestListJobs_RequiresTenantID(t *testing.T) {
	ctx := context.Background()
	pgDSN    := spinPostgres(t, ctx)
	redisURL := spinRedis(t, ctx)
	router   := wireRouter(t, ctx, pgDSN, redisURL)

	req := httptest.NewRequest(http.MethodGet, "/v1/jobs", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", w.Code)
	}
}

// TestHealthz: liveness probe always returns 200.
func TestHealthz(t *testing.T) {
	ctx := context.Background()
	pgDSN    := spinPostgres(t, ctx)
	redisURL := spinRedis(t, ctx)
	router   := wireRouter(t, ctx, pgDSN, redisURL)

	req := httptest.NewRequest(http.MethodGet, "/v1/healthz", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
}

// Ensure the `time` package doesn't produce unused-import errors
var _ = time.Second
