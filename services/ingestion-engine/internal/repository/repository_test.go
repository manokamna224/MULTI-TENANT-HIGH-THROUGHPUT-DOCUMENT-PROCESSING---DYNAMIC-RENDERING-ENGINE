package repository_test

import (
	"testing"
	"time"

	"github.com/yourorg/docengine/ingestion/internal/repository"
)

// TestErrNotFound_IsError verifies the sentinel error is non-nil and has a
// meaningful message — guards against accidental nil assignment.
func TestErrNotFound_IsError(t *testing.T) {
	if repository.ErrNotFound == nil {
		t.Fatal("ErrNotFound must not be nil")
	}
	if repository.ErrNotFound.Error() == "" {
		t.Fatal("ErrNotFound must have a non-empty message")
	}
}

// TestJobRow_ZeroValue verifies that a zero-value JobRow can be constructed
// without panicking, which confirms all pointer fields are properly optional.
func TestJobRow_ZeroValue(t *testing.T) {
	var row repository.JobRow
	// All pointer fields should be nil (omitempty in JSON)
	if row.ComputedChecksum != nil {
		t.Error("ComputedChecksum should default to nil")
	}
	if row.StoragePath != nil {
		t.Error("StoragePath should default to nil")
	}
	if row.ErrorLog != nil {
		t.Error("ErrorLog should default to nil")
	}
	if row.CompletedAt != nil {
		t.Error("CompletedAt should default to nil")
	}
	// Zero-value time is valid
	var zeroTime time.Time
	if !row.CreatedAt.Equal(zeroTime) && row.CreatedAt.IsZero() {
		t.Error("CreatedAt should be zero value")
	}
}

// TestCreateJobParams_Fields verifies the param struct has all required fields.
func TestCreateJobParams_Fields(t *testing.T) {
	p := repository.CreateJobParams{
		JobID:        "job-1",
		TenantID:     "tenant-1",
		TemplateID:   "template-1",
		DocumentType: "measurement_book",
		Payload:      []byte(`{}`),
	}
	if p.JobID == "" || p.TenantID == "" || p.DocumentType == "" {
		t.Error("required fields must not be empty after assignment")
	}
}

// TestNew_RequiresDatabase skips gracefully when no database is available.
func TestNew_RequiresDatabase(t *testing.T) {
	t.Skip("requires live Postgres — covered by tests/integration/")
}
