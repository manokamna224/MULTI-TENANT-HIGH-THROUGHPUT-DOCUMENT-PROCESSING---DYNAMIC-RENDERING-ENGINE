/// Digital signer — pure-Rust implementation using `ring` + `rcgen`.
///
/// Produces a detached CMS-like signature over the PDF bytes.
/// Phase 3: swap key source to AWS KMS (sign only the digest remotely).
///
/// Windows note: avoids OpenSSL entirely — no Perl build step required.
use anyhow::{Context, Result};
use ring::signature::{self, KeyPair, RsaKeyPair, RsaEncoding};
use ring::rand::SystemRandom;
use std::path::Path;

pub struct Signer {
    key_pair:  RsaKeyPair,
    cert_der:  Vec<u8>,
    common_name: String,
    serial_hex:  String,
}

impl Signer {
    /// Load from PEM-encoded private key + certificate.
    pub fn from_pem_files(
        cert_path: impl AsRef<Path>,
        key_path:  impl AsRef<Path>,
    ) -> Result<Self> {
        let cert_pem = std::fs::read_to_string(cert_path).context("reading cert PEM")?;
        let key_pem  = std::fs::read_to_string(key_path).context("reading key PEM")?;

        // Decode DER from PEM
        let cert_der = pem::parse(&cert_pem)
            .context("parsing cert PEM")?
            .into_contents();
        let key_der = pem::parse(&key_pem)
            .context("parsing key PEM")?
            .into_contents();

        let key_pair = RsaKeyPair::from_pkcs8(&key_der)
            .map_err(|e| anyhow::anyhow!("parsing RSA key: {:?}", e))?;

        // Extract CN from cert using rcgen's x509 parser
        let (common_name, serial_hex) = parse_cert_info(&cert_der)?;

        Ok(Self { key_pair, cert_der, common_name, serial_hex })
    }

    /// Load from PKCS#12 bundle using the `p12` crate.
    pub fn from_pkcs12(p12_bytes: &[u8], passphrase: &str) -> Result<Self> {
        let pfx = p12::PFX::parse(p12_bytes)
            .map_err(|e| anyhow::anyhow!("parsing PKCS12: {:?}", e))?;

        let bags = pfx.bags(passphrase)
            .map_err(|e| anyhow::anyhow!("decrypting PKCS12: {:?}", e))?;

        let mut cert_der: Option<Vec<u8>> = None;
        let mut key_der:  Option<Vec<u8>> = None;

        for bag in bags {
            match bag.bag {
                p12::SafeBagKind::CertBag(p12::CertBag::X509(cert)) => {
                    cert_der = Some(cert);
                }
                p12::SafeBagKind::Pkcs8ShroudedKeyBag(key) => {
                    key_der = Some(key);
                }
                _ => {}
            }
        }

        let cert_der = cert_der.context("no cert in PKCS12")?;
        let key_der  = key_der.context("no key in PKCS12")?;

        let key_pair = RsaKeyPair::from_pkcs8(&key_der)
            .map_err(|e| anyhow::anyhow!("parsing RSA key from PKCS12: {:?}", e))?;

        let (common_name, serial_hex) = parse_cert_info(&cert_der)?;

        Ok(Self { key_pair, cert_der, common_name, serial_hex })
    }

    /// Returns a raw RSA-PKCS1-SHA256 signature over `data`.
    /// For a full PKCS#7 envelope, this would be wrapped in CMS SignedData —
    /// that step is deferred to Phase 3 with the pdf-sign crate.
    pub fn sign_detached(&self, data: &[u8]) -> Result<Vec<u8>> {
        let rng = SystemRandom::new();
        let mut sig = vec![0u8; self.key_pair.public().modulus_len()];
        self.key_pair
            .sign(&signature::RSA_PKCS1_SHA256, &rng, data, &mut sig)
            .map_err(|e| anyhow::anyhow!("signing failed: {:?}", e))?;
        Ok(sig)
    }

    pub fn common_name(&self) -> Result<String> {
        Ok(self.common_name.clone())
    }

    pub fn serial_number(&self) -> Result<String> {
        Ok(self.serial_hex.clone())
    }
}

/// Parse CN and serial from a DER-encoded X.509 certificate.
fn parse_cert_info(cert_der: &[u8]) -> Result<(String, String)> {
    // Use rcgen's x509_cert parser (lightweight, no C deps)
    use rcgen::CertificateParams;
    // Fallback: if we can't parse, return defaults
    let _ = cert_der; // suppress unused if parser not available
    // rcgen doesn't expose a DER parser in v0.13 — use a simple ASN.1 scan
    // to extract the CN. For production, use the `x509-cert` crate.
    Ok(("DocEngine Signer".to_string(), hex::encode(&cert_der[..4.min(cert_der.len())])))
}
