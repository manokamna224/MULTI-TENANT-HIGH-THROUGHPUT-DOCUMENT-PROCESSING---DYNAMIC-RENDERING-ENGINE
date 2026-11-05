/// PostgreSQL client for the crypto-signing service.
///
/// Writes one row to `signature_records` after every successful signing
/// operation, providing a tamper-evident audit trail of every PDF that was
/// signed, by which certificate, and at what time.
use anyhow::{Context, Result};
use tokio_postgres::{Client, NoTls};
use tracing::{debug, warn};

pub struct DbClient {
    client: Client,
}

impl DbClient {
    /// Connect using DATABASE_URL. Returns None if the variable is absent.
    pub async fn from_env() -> Result<Option<Self>> {
        let url = match std::env::var("DATABASE_URL") {
            Ok(u) => u,
            Err(_) => {
                warn!("DATABASE_URL not set — signature_records will not be persisted");
                return Ok(None);
            }
        };

        let (client, conn) = tokio_postgres::connect(&url, NoTls)
            .await
            .context("connecting to postgres")?;

        tokio::spawn(async move {
            if let Err(e) = conn.await {
                tracing::error!(error = %e, "postgres connection lost");
            }
        });

        Ok(Some(Self { client }))
    }

    /// Insert a row into signature_records.
    ///
    /// `sig_der` is the raw DER bytes of the PKCS#7 CMS envelope, stored for
    /// offline re-verification without needing to re-fetch the PDF.
    pub async fn insert_signature_record(
        &self,
        job_id:        &str,
        tenant_id:     &str,
        signer_cn:     &str,
        certificate_sn: &str,
        document_hash: &str,
        sig_der:       &[u8],
    ) -> Result<()> {
        self.client
            .execute(
                "INSERT INTO signature_records
                    (job_id, tenant_id, signer_cn, certificate_sn,
                     digest_algo, document_hash, pkcs7_der)
                 VALUES ($1, $2, $3, $4, 'SHA-256', $5, $6)",
                &[
                    &job_id,
                    &tenant_id,
                    &signer_cn,
                    &certificate_sn,
                    &document_hash,
                    &sig_der,
                ],
            )
            .await
            .context("inserting signature record")?;

        debug!(job_id, "signature_records row inserted");
        Ok(())
    }
}
