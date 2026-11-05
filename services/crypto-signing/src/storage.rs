/// S3 artifact download and upload for the signing pipeline.
use anyhow::{Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_s3::{config::Builder as S3Builder, Client};
use aws_sdk_s3::primitives::ByteStream;

pub struct ArtifactStore {
    client: Client,
    bucket: String,
}

impl ArtifactStore {
    pub async fn new(bucket: String, endpoint_override: Option<String>) -> Result<Self> {
        let sdk_cfg = aws_config::defaults(BehaviorVersion::latest()).load().await;
        let s3_cfg = if let Some(ep) = endpoint_override {
            S3Builder::from(&sdk_cfg)
                .endpoint_url(ep)
                .force_path_style(true)
                .build()
        } else {
            S3Builder::from(&sdk_cfg).build()
        };
        Ok(Self { client: Client::from_conf(s3_cfg), bucket })
    }

    /// Downloads an object and returns its bytes.
    pub async fn download(&self, key: &str) -> Result<Vec<u8>> {
        let resp = self.client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("downloading s3://{}/{}", self.bucket, key))?;

        let bytes = resp.body
            .collect()
            .await
            .context("reading S3 response body")?
            .into_bytes()
            .to_vec();

        Ok(bytes)
    }

    /// Uploads bytes to the given key (overwrites if exists).
    pub async fn upload(&self, key: &str, data: Vec<u8>, content_type: &str) -> Result<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_type(content_type)
            .server_side_encryption(aws_sdk_s3::types::ServerSideEncryption::Aes256)
            .body(ByteStream::from(data))
            .send()
            .await
            .with_context(|| format!("uploading s3://{}/{}", self.bucket, key))?;
        Ok(())
    }

    /// Extracts the S3 key from a full "s3://bucket/key" path.
    pub fn key_from_path<'a>(path: &'a str, bucket: &str) -> &'a str {
        let prefix = format!("s3://{}/", bucket);
        path.strip_prefix(&prefix).unwrap_or(path)
    }
}
