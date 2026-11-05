/// PDF linearization (Fast Web View) wrapper.
///
/// Linearization reorders PDF objects so the first page is accessible before
/// the full file downloads. We shell out to `qpdf --linearize` which is
/// battle-tested, LGPL-licensed, and produces spec-compliant output.
///
/// Future: replace with a pure-Rust PDF writer if lopdf or pdf-writer
/// gains linearization support.
use anyhow::{bail, Context, Result};
use tokio::process::Command;
use tracing::debug;

/// Linearizes PDF bytes by writing to a temp file, running qpdf, and reading back.
pub async fn linearize(pdf_bytes: &[u8]) -> Result<Vec<u8>> {
    let tmp = tempfile::tempdir().context("creating temp dir")?;
    let input  = tmp.path().join("input.pdf");
    let output = tmp.path().join("linearized.pdf");

    tokio::fs::write(&input, pdf_bytes)
        .await
        .context("writing input PDF")?;

    let status = Command::new("qpdf")
        .arg("--linearize")
        .arg(&input)
        .arg(&output)
        .kill_on_drop(true)
        .status()
        .await
        .context("launching qpdf")?;

    if !status.success() {
        bail!("qpdf --linearize exited with code {:?}", status.code());
    }

    let linearized = tokio::fs::read(&output)
        .await
        .context("reading linearized PDF")?;

    debug!(
        original_bytes = pdf_bytes.len(),
        linearized_bytes = linearized.len(),
        "linearization complete"
    );

    Ok(linearized)
}
