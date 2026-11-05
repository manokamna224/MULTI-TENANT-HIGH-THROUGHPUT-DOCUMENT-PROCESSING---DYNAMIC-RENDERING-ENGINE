/// Tamper-evident document manifest.
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use image::DynamicImage;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Cursor;

#[derive(Debug, Serialize, Deserialize)]
pub struct DocumentManifest {
    pub job_id:        String,
    pub tenant_id:     String,
    pub document_type: String,
    pub signed_at:     DateTime<Utc>,
    /// Hex-encoded SHA-256 of the pre-signature PDF bytes.
    pub sha256:        String,
    pub signer_cn:     String,
}

impl DocumentManifest {
    pub fn new(
        job_id:        impl Into<String>,
        tenant_id:     impl Into<String>,
        document_type: impl Into<String>,
        pdf_bytes:     &[u8],
        signer_cn:     impl Into<String>,
    ) -> Self {
        let sha256 = hex::encode(Sha256::digest(pdf_bytes));
        Self {
            job_id:        job_id.into(),
            tenant_id:     tenant_id.into(),
            document_type: document_type.into(),
            signed_at:     Utc::now(),
            sha256,
            signer_cn:     signer_cn.into(),
        }
    }

    pub fn to_qr_payload(&self) -> Result<String> {
        serde_json::to_string(self).context("serialising manifest to JSON")
    }

    /// Render the manifest as a QR code PNG (200×200 px).
    pub fn render_qr_png(&self) -> Result<Vec<u8>> {
        let payload = self.to_qr_payload()?;
        let code = QrCode::new(payload.as_bytes()).context("generating QR code")?;

        let img = code.render::<image::Luma<u8>>()
            .max_dimensions(200, 200)
            .build();

        let dynamic = DynamicImage::ImageLuma8(img);
        let mut buf = Cursor::new(Vec::new());
        // image v0.25: write_to takes ImageFormat enum, not ImageOutputFormat
        dynamic
            .write_to(&mut buf, image::ImageFormat::Png)
            .context("encoding QR PNG")?;

        Ok(buf.into_inner())
    }
}

#[cfg(test)]
#[path = "manifest_test.rs"]
mod tests;
