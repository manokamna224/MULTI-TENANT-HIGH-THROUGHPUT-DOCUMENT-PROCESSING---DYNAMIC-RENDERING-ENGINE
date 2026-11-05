use anyhow::{Context, Result};

/// Runtime configuration for the crypto-signing service.
#[derive(Debug, Clone)]
pub struct Config {
    /// Redis URL — consumed from render:results stream.
    pub redis_url: String,
    pub consumer_group: String,
    pub consumer_name: String,
    /// S3 bucket where signed PDFs are written (overwrites unsigned artifact).
    pub artifact_bucket: String,
    pub s3_endpoint: Option<String>,
    /// Signing key source: "pem", "pkcs12", or "kms".
    pub key_source: KeySource,
}

#[derive(Debug, Clone)]
pub enum KeySource {
    /// PEM files on disk — development / self-signed.
    Pem {
        cert_path: String,
        key_path:  String,
    },
    /// PKCS#12 bundle — production with file-based certs.
    Pkcs12 {
        path:       String,
        passphrase: String,
    },
    /// AWS KMS — key never leaves KMS; only the hash digest is sent.
    Kms {
        key_arn: String,
        region:  String,
    },
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let key_source = match env_or("SIGNING_KEY_SOURCE", "pem").as_str() {
            "pem" => KeySource::Pem {
                cert_path: env("SIGNING_CERT_PATH")?,
                key_path:  env("SIGNING_KEY_PATH")?,
            },
            "pkcs12" => KeySource::Pkcs12 {
                path:       env("SIGNING_P12_PATH")?,
                passphrase: env("SIGNING_P12_PASS")?,
            },
            "kms" => KeySource::Kms {
                key_arn: env("KMS_KEY_ARN")?,
                region:  env_or("AWS_REGION", "ap-south-1"),
            },
            other => anyhow::bail!("unknown SIGNING_KEY_SOURCE: {other}"),
        };

        Ok(Self {
            redis_url:        env("REDIS_URL")?,
            consumer_group:   env_or("CONSUMER_GROUP", "signing-workers"),
            consumer_name:    env_or("CONSUMER_NAME", &format!("signer-{}", uuid::Uuid::new_v4())),
            artifact_bucket:  env_or("ARTIFACT_BUCKET", "docengine-artifacts"),
            s3_endpoint:      std::env::var("S3_ENDPOINT").ok(),
            key_source,
        })
    }
}

fn env(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("required env var {key} not set"))
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}
