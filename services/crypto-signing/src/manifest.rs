/// Tamper-evident document manifest.
///
/// The manifest is:
///   1. SHA-256 hashed from the raw PDF bytes
///   2. Serialised to a compact JSON string
///   3. Encoded as a QR code PNG embedded on the last page of the document
///
/// Offline verification: scan QR → decode JSON → recompute hash → compare.
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use hex;
use image::{ImageOutputFormat, DynamicImage};
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Cursor;

#[derive(Debug, Serialize, Deserialize)]
pub struct DocumentManifest {
    pub job_id: String,
    pub tenant_id: String,
    pub document_type: String,
    /// ISO-8601 timestamp of signing
    pub signed_at: DateTime<Utc>,
    /// Hex-encoded SHA-256 of the pre-signature PDF bytes
    pub sha256: String,
    /// Issuer common name from the signing certificate
    pub signer_cn: String,
}

impl DocumentManifest {
    pub fn new(
        job_id: impl Into<String>,
        tenant_id: impl Into<String>,
        document_type: impl Into<String>,
        pdf_bytes: &[u8],
        signer_cn: impl Into<String>,
    ) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(pdf_bytes);
        let sha256 = hex::encode(hasher.finalize());

        Self {
            job_id: job_id.into(),
            tenant_id: tenant_id.into(),
            document_type: document_type.into(),
            signed_at: Utc::now(),
            sha256,
            signer_cn: signer_cn.into(),
        }
    }

    /// Serialises the manifest to compact JSON for QR encoding.
    pub fn to_qr_payload(&self) -> Result<String> {
        serde_json::to_string(self).context("serialising manifest to JSON")
    }

    /// Renders the manifest as a QR code and returns PNG bytes.
    /// The PNG is sized at 200×200 pixels — suitable for embedding on A4.
    pub fn render_qr_png(&self) -> Result<Vec<u8>> {
        let payload = self.to_qr_payload()?;
        let code = QrCode::new(payload.as_bytes()).context("generating QR code")?;

        // Render as image::DynamicImage
        let image = code.render::<image::Luma<u8>>()
            .max_dimensions(200, 200)
            .build();

        let dynamic = DynamicImage::ImageLuma8(image);
        let mut buf = Cursor::new(Vec::new());
        dynamic
            .write_to(&mut buf, ImageOutputFormat::Png)
            .context("encoding QR PNG")?;

        Ok(buf.into_inner())
    }
}

#[cfg(test)]
#[path = "manifest_test.rs"]
mod tests;
