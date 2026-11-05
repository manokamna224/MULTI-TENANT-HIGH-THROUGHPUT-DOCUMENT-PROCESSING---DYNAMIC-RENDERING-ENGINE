// Package queue — stream retry sweeper.
//
// Jobs reach status='queued' in Postgres but never appear on the Redis Stream
// when the process crashes between the DB INSERT and the XADD. The sweeper
// polls for such stuck rows every SWEEP_INTERVAL and re-publishes them.
//
// Duplicate delivery is safe: render workers XACK only after the PDF is
// uploaded to S3, so a duplicate message produces a second upload attempt
// that overwrites the same S3 key — idempotent.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

const sweepInterval  = 30 * time.Second
const sweepBatchSize = 50
const stuckThreshold = 2 * time.Minute

// RetrySweeper polls render_jobs for stuck 'queued' rows and re-publishes them.
type RetrySweeper struct {
	pool      *pgxpool.Pool
	publisher *RedisPublisher
	log       *zap.Logger
}

// NewRetrySweeper creates a sweeper. The pgxpool is shared with the repository.
func NewRetrySweeper(pool *pgxpool.Pool, publisher *RedisPublisher, log *zap.Logger) *RetrySweeper {
	return &RetrySweeper{pool: pool, publisher: publisher, log: log}
}

// Run starts the periodic sweep loop. Call as a goroutine; cancel ctx to stop.
func (s *RetrySweeper) Run(ctx context.Context) {
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()

	s.log.Info("retry sweeper started", zap.Duration("interval", sweepInterval))
	for {
		select {
		case <-ctx.Done():
			s.log.Info("retry sweeper stopped")
			return
		case <-ticker.C:
			if err := s.sweep(ctx); err != nil && !errors.Is(err, context.Canceled) {
				s.log.Error("sweep cycle failed", zap.Error(err))
			}
		}
	}
}

func (s *RetrySweeper) sweep(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `
		SELECT job_id, tenant_id, template_id, document_type, input_payload
		FROM   render_jobs
		WHERE  status = 'queued'
		  AND  created_at < NOW() - make_interval(secs => $1)
		ORDER  BY created_at
		LIMIT  $2`,
		int(stuckThreshold.Seconds()),
		sweepBatchSize,
	)
	if err != nil {
		return fmt.Errorf("querying stuck jobs: %w", err)
	}
	defer rows.Close()

	var count int
	for rows.Next() {
		var (
			jobID, tenantID, templateID, docType string
			payload                              json.RawMessage
		)
		if err := rows.Scan(&jobID, &tenantID, &templateID, &docType, &payload); err != nil {
			s.log.Error("scanning stuck job row", zap.Error(err))
			continue
		}

		job := RenderJob{
			JobID:        jobID,
			TenantID:     tenantID,
			TemplateID:   templateID,
			DocumentType: docType,
			Payload:      payload,
			EnqueuedAt:   time.Now().UTC(),
		}

		if pubErr := s.publisher.Publish(ctx, job); pubErr != nil {
			s.log.Error("re-publishing stuck job", zap.String("job_id", jobID), zap.Error(pubErr))
		} else {
			s.log.Info("re-published stuck job", zap.String("job_id", jobID))
			count++
		}
	}

	if count > 0 {
		s.log.Info("sweep complete", zap.Int("republished", count))
	}
	return rows.Err()
}
