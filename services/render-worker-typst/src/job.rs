use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Canonical render job consumed from the Redis Stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderJob {
    pub job_id:        String,
    pub tenant_id:     String,
    pub template_id:   String,
    pub document_type: String,
    /// Raw document payload — injected into the Typst template via --input.
    pub payload:       Value,
    pub enqueued_at:   String,
}

/// Terminal outcome published to render:results.
///
/// Consumed by:
///   - crypto-signing   → needs job_id, tenant_id, document_type, storage_path, checksum
///   - artifact-storage → needs all fields to build webhook payload
///   - ingestion-engine → DB update via mark_completed / mark_failed
#[derive(Debug, Serialize, Deserialize)]
pub struct JobResult {
    pub job_id:            String,
    pub tenant_id:         String,
    pub document_type:     String,
    pub status:            JobStatus,
    pub storage_path:      Option<String>,
    /// Hex-encoded SHA-256 of the rendered PDF bytes (pre-signature).
    pub computed_checksum: Option<String>,
    pub execution_time_ms: u64,
    pub error_log:         Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Completed,
    Failed,
}
