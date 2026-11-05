// Package repository manages render_jobs database persistence.
// Uses pgx/v5 directly (no ORM) for predictable query plans and explicit
// JSONB handling.
package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a requested job does not exist.
var ErrNotFound = errors.New("job not found")

// JobRow mirrors the render_jobs table columns returned to callers.
type JobRow struct {
	JobID            string          `json:"job_id"`
	TenantID         string          `json:"tenant_id"`
	TemplateID       string          `json:"template_id"`
	DocumentType     string          `json:"document_type"`
	Status           string          `json:"status"`
	ComputedChecksum *string         `json:"computed_checksum,omitempty"`
	StoragePath      *string         `json:"storage_path,omitempty"`
	ExecutionTimeMs  *int            `json:"execution_time_ms,omitempty"`
	RetryCount       int             `json:"retry_count"`
	ErrorLog         *string         `json:"error_log,omitempty"`
	CreatedAt        time.Time       `json:"created_at"`
	CompletedAt      *time.Time      `json:"completed_at,omitempty"`
}

// CreateJobParams bundles the fields needed to insert a new job.
type CreateJobParams struct {
	JobID        string
	TenantID     string
	TemplateID   string
	DocumentType string
	Payload      json.RawMessage
}

// JobRepository wraps a pgxpool.Pool for render_jobs operations.
type JobRepository struct {
	pool *pgxpool.Pool
}

// New opens and validates a pgxpool connection.
func New(ctx context.Context, databaseURL string) (*JobRepository, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parsing database URL: %w", err)
	}
	cfg.MaxConns = 20
	cfg.MinConns = 2
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("creating pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}

	return &JobRepository{pool: pool}, nil
}

// Close releases all pool connections.
func (r *JobRepository) Close() {
	r.pool.Close()
}

// Pool returns the underlying pgxpool for use by the retry sweeper.
// Callers must not close the pool directly.
func (r *JobRepository) Pool() *pgxpool.Pool {
	return r.pool
}

// CreateJob inserts a new render_jobs row with status='queued'.
// The job_id is provided by the caller (UUID generated in the API layer)
// so that it can be returned to the client before the DB write completes.
func (r *JobRepository) CreateJob(ctx context.Context, p CreateJobParams) error {
	const q = `
		INSERT INTO render_jobs
			(job_id, tenant_id, template_id, document_type, status, input_payload)
		VALUES
			($1, $2, $3, $4, 'queued', $5)`

	_, err := r.pool.Exec(ctx, q,
		p.JobID, p.TenantID, p.TemplateID, p.DocumentType, p.Payload,
	)
	if err != nil {
		return fmt.Errorf("inserting render job: %w", err)
	}
	return nil
}

// GetJob fetches a single job row by job_id.
// Returns ErrNotFound if no row exists.
func (r *JobRepository) GetJob(ctx context.Context, jobID string) (*JobRow, error) {
	const q = `
		SELECT
			job_id, tenant_id, template_id, document_type, status,
			computed_checksum, storage_path, execution_time_ms, retry_count,
			error_log, created_at, completed_at
		FROM render_jobs
		WHERE job_id = $1`

	row := r.pool.QueryRow(ctx, q, jobID)
	var j JobRow
	err := row.Scan(
		&j.JobID, &j.TenantID, &j.TemplateID, &j.DocumentType, &j.Status,
		&j.ComputedChecksum, &j.StoragePath, &j.ExecutionTimeMs, &j.RetryCount,
		&j.ErrorLog, &j.CreatedAt, &j.CompletedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("querying job %s: %w", jobID, err)
	}
	return &j, nil
}

// UpdateJobCompleted marks a job as completed and records its artifact path,
// checksum, and execution time.
func (r *JobRepository) UpdateJobCompleted(
	ctx context.Context,
	jobID, storagePath, checksum string,
	execMs int,
) error {
	const q = `
		UPDATE render_jobs SET
			status            = 'completed',
			storage_path      = $2,
			computed_checksum = $3,
			execution_time_ms = $4,
			completed_at      = NOW()
		WHERE job_id = $1`

	tag, err := r.pool.Exec(ctx, q, jobID, storagePath, checksum, execMs)
	if err != nil {
		return fmt.Errorf("updating job completed: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateJobFailed marks a job as failed with an error log entry.
// Increments retry_count so the dead-letter reaper can enforce MAX_RETRIES.
func (r *JobRepository) UpdateJobFailed(ctx context.Context, jobID, errorLog string) error {
	const q = `
		UPDATE render_jobs SET
			status      = 'failed',
			error_log   = $2,
			retry_count = retry_count + 1,
			completed_at = NOW()
		WHERE job_id = $1`

	tag, err := r.pool.Exec(ctx, q, jobID, errorLog)
	if err != nil {
		return fmt.Errorf("updating job failed: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateJobProcessing transitions status from 'queued' → 'processing'.
// Uses a conditional update to prevent double-claiming the same job.
func (r *JobRepository) UpdateJobProcessing(ctx context.Context, jobID string) error {
	const q = `
		UPDATE render_jobs SET status = 'processing'
		WHERE job_id = $1 AND status = 'queued'`

	tag, err := r.pool.Exec(ctx, q, jobID)
	if err != nil {
		return fmt.Errorf("updating job processing: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("job %s not in queued state (concurrent claim?)", jobID)
	}
	return nil
}

// ListJobsByTenant returns paginated jobs for a tenant, newest first.
func (r *JobRepository) ListJobsByTenant(
	ctx context.Context,
	tenantID string,
	limit, offset int,
) ([]*JobRow, error) {
	const q = `
		SELECT
			job_id, tenant_id, template_id, document_type, status,
			computed_checksum, storage_path, execution_time_ms, retry_count,
			error_log, created_at, completed_at
		FROM render_jobs
		WHERE tenant_id = $1
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3`

	rows, err := r.pool.Query(ctx, q, tenantID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("listing jobs for tenant %s: %w", tenantID, err)
	}
	defer rows.Close()

	var jobs []*JobRow
	for rows.Next() {
		var j JobRow
		if err := rows.Scan(
			&j.JobID, &j.TenantID, &j.TemplateID, &j.DocumentType, &j.Status,
			&j.ComputedChecksum, &j.StoragePath, &j.ExecutionTimeMs, &j.RetryCount,
			&j.ErrorLog, &j.CreatedAt, &j.CompletedAt,
		); err != nil {
			return nil, fmt.Errorf("scanning job row: %w", err)
		}
		jobs = append(jobs, &j)
	}
	return jobs, rows.Err()
}
