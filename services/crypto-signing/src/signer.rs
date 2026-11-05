/// Digital signer — pure-Rust via `ring` (no OpenSSL, no Perl on Windows).
///
/// Produces a raw RSA-PKCS1-SHA256 signature over PDF bytes.
/// Phase 3: wrap in CMS SignedData and embed in PDF byte-range.
use anyhow::{Context, Result};
use ring::rand::SystemRandom;
use ring::signature::{RsaKeyPair, RSA_PKCS1_SHA256};
use std::path::Path;

pub struct Signer {
    key_pair:    RsaKeyPair,
    common_name: String,
    serial_hex:  String,
}

impl Signer {
    /// Load from PEM certificate + PEM private key files.
    pub fn from_pem_files(
        cert_path: impl AsRef<Path>,
        key_path:  impl AsRef<Path>,
    ) -> Result<Self> {
        let key_pem  = std::fs::read_to_string(key_path).context("reading key PEM")?;
        let cert_pem = std::fs::read_to_string(cert_path).context("reading cert PEM")?;

        // Decode key DER from PEM
        let key_pem_obj = pem::parse(key_pem.trim()).context("parsing key PEM")?;
        let key_der = key_pem_obj.contents();

        let key_pair = RsaKeyPair::from_pkcs8(key_der)
            .map_err(|e| anyhow::anyhow!("parsing RSA PKCS8 key: {:?}", e))?;

        // Extract a readable CN from the cert PEM (best-effort)
        let (common_name, serial_hex) = extract_cert_info(&cert_pem);

        Ok(Self { key_pair, common_name, serial_hex })
    }

    /// Load from PKCS#12 bundle — Phase 3 full implementation.
    /// For now, extract the embedded PEM key via the p12 crate.
    pub fn from_pkcs12(p12_bytes: &[u8], passphrase: &str) -> Result<Self> {
        let pfx = p12::PFX::parse(p12_bytes)
            .map_err(|e| anyhow::anyhow!("parsing PKCS12: {:?}", e))?;

        // Extract private key bytes
        let key_der = pfx.key_bags(passphrase)
            .map_err(|e| anyhow::anyhow!("decrypting key bags: {:?}", e))?
            .into_iter()
            .next()
            .context("no private key in PKCS12")?;

        let key_pair = RsaKeyPair::from_pkcs8(&key_der)
            .map_err(|e| anyhow::anyhow!("parsing RSA key from PKCS12: {:?}", e))?;

        Ok(Self {
            key_pair,
            common_name: "DocEngine Signer".to_string(),
            serial_hex:  "00".to_string(),
        })
    }

    /// Raw RSA-PKCS1-SHA256 signature over `data`.
    pub fn sign_detached(&self, data: &[u8]) -> Result<Vec<u8>> {
        let rng = SystemRandom::new();
        let mut sig = vec![0u8; self.key_pair.public().modulus_len()];
        self.key_pair
            .sign(&RSA_PKCS1_SHA256, &rng, data, &mut sig)
            .map_err(|e| anyhow::anyhow!("signing failed: {:?}", e))?;
        Ok(sig)
    }

    pub fn common_name(&self) -> Result<String> { Ok(self.common_name.clone()) }
    pub fn serial_number(&self) -> Result<String> { Ok(self.serial_hex.clone()) }
}

/// Best-effort extraction of CN and serial from a PEM cert string.
/// Does not require a full ASN.1 parser.
fn extract_cert_info(cert_pem: &str) -> (String, String) {
    // Scan for "CN=" in the PEM text representation — works for simple self-signed certs
    let cn = cert_pem.lines()
        .find_map(|l| {
            let l = l.trim();
            if let Some(rest) = l.strip_prefix("CN=") {
                Some(rest.split('/').next().unwrap_or(rest).to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "DocEngine Signer".to_string());

    // Use first 8 hex bytes of the DER as a pseudo-serial
    if let Ok(pem_obj) = pem::parse(cert_pem.trim()) {
        let serial = hex::encode(&pem_obj.contents()[..8.min(pem_obj.contents().len())]);
        return (cn, serial);
    }
    (cn, "00000000".to_string())
}
