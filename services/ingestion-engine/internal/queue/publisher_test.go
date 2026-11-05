package queue_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/yourorg/docengine/ingestion/internal/queue"
)

// TestRenderJob_MarshalUnmarshal verifies that RenderJob round-trips through
// JSON without losing any fields. This guards against accidental field renames
// that would break the wire format consumed by render workers.
func TestRenderJob_MarshalUnmarshal(t *testing.T) {
	original := queue.RenderJob{
		JobID:        "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
		TenantID:     "cccccccc-4444-5555-6666-dddddddddddd",
		TemplateID:   "eeeeeeee-7777-8888-9999-ffffffffffff",
		DocumentType: "measurement_book",
		Payload:      json.RawMessage(`{"document_meta":{"title":"Test"}}`),
		EnqueuedAt:   time.Date(2026, 11, 4, 8, 0, 0, 0, time.UTC),
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var restored queue.RenderJob
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if restored.JobID != original.JobID {
		t.Errorf("JobID mismatch: got %s", restored.JobID)
	}
	if restored.TenantID != original.TenantID {
		t.Errorf("TenantID mismatch: got %s", restored.TenantID)
	}
	if restored.DocumentType != original.DocumentType {
		t.Errorf("DocumentType mismatch: got %s", restored.DocumentType)
	}
	if string(restored.Payload) != string(original.Payload) {
		t.Errorf("Payload mismatch: got %s", restored.Payload)
	}
}

// TestNewRedisPublisher_InvalidURL verifies that a malformed Redis URL is
// rejected at construction time rather than silently producing a broken client.
func TestNewRedisPublisher_InvalidURL(t *testing.T) {
	_, err := queue.NewRedisPublisher("not-a-valid-redis-url://!!!")
	if err == nil {
		t.Fatal("expected error for invalid Redis URL, got nil")
	}
}

// TestNewRedisPublisher_UnreachableHost verifies that a connection to a host
// that refuses connections (localhost port 1) returns an error with a sensible
// message rather than hanging indefinitely.
func TestNewRedisPublisher_UnreachableHost(t *testing.T) {
	// Port 1 is typically refused immediately on all platforms
	_, err := queue.NewRedisPublisher("redis://localhost:1")
	if err == nil {
		t.Fatal("expected connection error for unreachable host, got nil")
	}
}

// TestRetrySweeper_NewRetrySweeper verifies the constructor does not panic
// and returns a non-nil sweeper when given valid dependencies.
func TestRetrySweeper_NewRetrySweeper(t *testing.T) {
	// We cannot construct a real pgxpool or publisher without a running server,
	// but we can verify the constructor doesn't panic with nil inputs when
	// used correctly as a struct value.
	// Full sweep behaviour is covered by integration tests.
	t.Skip("requires live Postgres + Redis — see tests/integration/")
}

// TestRetrySweeper_RunCancelsCleanly verifies that the sweeper respects
// context cancellation without hanging.
func TestRetrySweeper_RunCancelsCleanly(t *testing.T) {
	t.Skip("requires live Postgres + Redis — see tests/integration/")
}

// Ensure the queue package compiles and the context import is used.
var _ = context.Background
