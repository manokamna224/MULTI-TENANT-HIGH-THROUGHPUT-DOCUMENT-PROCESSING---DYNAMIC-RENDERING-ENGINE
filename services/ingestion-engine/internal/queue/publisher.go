// Package queue wraps Redis Streams for durable job publishing.
// Stream key: "render:jobs"
// Consumer groups are managed by the render workers, not the ingestion engine.
package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const streamKey = "render:jobs"

// RenderJob is the canonical message published to the Redis Stream.
type RenderJob struct {
	JobID        string          `json:"job_id"`
	TenantID     string          `json:"tenant_id"`
	TemplateID   string          `json:"template_id"`
	DocumentType string          `json:"document_type"`
	Payload      json.RawMessage `json:"payload"`
	EnqueuedAt   time.Time       `json:"enqueued_at"`
}

// RedisPublisher publishes render jobs to a Redis Stream.
type RedisPublisher struct {
	client *redis.Client
}

// NewRedisPublisher parses redisURL and opens a connection.
func NewRedisPublisher(redisURL string) (*RedisPublisher, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parsing redis URL: %w", err)
	}
	client := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping failed: %w", err)
	}

	return &RedisPublisher{client: client}, nil
}

// Publish serialises the job and adds it to the Redis Stream with MAXLEN trimming.
// Uses XADD with MAXLEN ~ 100_000 to bound memory usage.
func (p *RedisPublisher) Publish(ctx context.Context, job RenderJob) error {
	data, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshalling render job: %w", err)
	}

	args := &redis.XAddArgs{
		Stream: streamKey,
		MaxLen: 100_000,
		Approx: true, // ~ prefix for amortised trimming
		Values: map[string]interface{}{
			"job_id":  job.JobID,
			"payload": string(data),
		},
	}

	id, err := p.client.XAdd(ctx, args).Result()
	if err != nil {
		return fmt.Errorf("XADD to stream %s: %w", streamKey, err)
	}

	_ = id // stream entry ID, useful for debugging
	return nil
}

// Close releases the Redis connection.
func (p *RedisPublisher) Close() error {
	return p.client.Close()
}
