/// S3-compatible artifact storage.
///
/// Object key pattern:  <tenant_id>/<document_type>/<year>/<month>/<job_id>.pdf
/// This layout gives per-tenant cost attribution and allows lifecycle rules
/// to expire old artifacts by prefix without scanning the full bucket.
use anyhow::{Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_s3::{config::Builder as S3Builder, Client as S3Client};
use aws_sdk_s3::primitives::ByteStream;
use chrono::Datelike; // required for .year() / .month() on DateTime
use tracing::info;

pub struct ArtifactStorage {
    client: S3Client,
    bucket: String,
}

impl ArtifactStorage {
    pub async fn new(bucket: String, endpoint_override: Option<String>) -> Result<Self> {
        let sdk_config = aws_config::defaults(BehaviorVersion::latest()).load().await;

        let s3_config = if let Some(endpoint) = endpoint_override {
            S3Builder::from(&sdk_config)
                .endpoint_url(endpoint)
                .force_path_style(true)
                .build()
        } else {
            S3Builder::from(&sdk_config).build()
        };

        let client = S3Client::from_conf(s3_config);
        Ok(Self { client, bucket })
    }

    /// Uploads PDF bytes and returns the storage path (s3://bucket/key).
    pub async fn upload_pdf(
        &self,
        tenant_id: &str,
        document_type: &str,
        job_id: &str,
        pdf_bytes: Vec<u8>,
    ) -> Result<String> {
        let now = chrono::Utc::now();
        let key = format!(
            "{tenant_id}/{document_type}/{year}/{month:02}/{job_id}.pdf",
            year = now.year(),
            month = now.month(),
        );

        let body = ByteStream::from(pdf_bytes);

        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .content_type("application/pdf")
            .body(body)
            .send()
            .await
            .with_context(|| format!("uploading PDF to s3://{}/{}", self.bucket, key))?;

        let path = format!("s3://{}/{}", self.bucket, key);
        info!(path = %path, "artifact uploaded");
        Ok(path)
    }
}
