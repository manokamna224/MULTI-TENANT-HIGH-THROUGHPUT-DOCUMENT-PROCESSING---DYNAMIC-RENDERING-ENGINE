/// Typst-based PDF renderer.
///
/// Architecture decision:
///   We invoke the `typst` CLI as a subprocess rather than linking the library
///   directly. This isolates any Typst panic/OOM inside a child process, giving
///   us a hard memory and CPU ceiling (via cgroups on Linux) without crashing
///   the worker. The tradeoff is ~2 ms fork overhead per job — acceptable given
///   the 150 ms latency budget.
///
///   When Typst stabilises its Rust library API in a future release, we can
///   switch to direct `typst::compile()` calls for zero-fork overhead.
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout;
use tracing::debug;

const RENDER_TIMEOUT: Duration = Duration::from_secs(30);

pub struct TypstRenderer {
    template_dir: PathBuf,
}

impl TypstRenderer {
    pub fn new(template_dir: impl AsRef<Path>) -> Self {
        Self {
            template_dir: template_dir.as_ref().to_path_buf(),
        }
    }

    /// Renders `template_name` with the given JSON payload.
    ///
    /// Returns the raw PDF bytes on success.
    /// The payload is written to a temp file and passed via `--input data_file=<path>`
    /// so the Typst template reads it with `sys.inputs.at("data_file")`.
    pub async fn render(
        &self,
        template_name: &str,
        payload_json: &str,
    ) -> Result<(Vec<u8>, Duration)> {
        let template_path = self.template_dir.join(format!("{template_name}.typ"));
        if !template_path.exists() {
            bail!("template not found: {}", template_path.display());
        }

        // Write payload to a temporary file — avoids shell injection in CLI args.
        let tmp_dir = tempfile::tempdir().context("creating temp dir")?;
        let data_path = tmp_dir.path().join("payload.json");
        tokio::fs::write(&data_path, payload_json)
            .await
            .context("writing payload temp file")?;

        let output_path = tmp_dir.path().join("output.pdf");

        let start = Instant::now();
        let result = timeout(RENDER_TIMEOUT, self.exec_typst(
            &template_path,
            &data_path,
            &output_path,
        ))
        .await
        .context("render timed out")?;

        result.context("typst subprocess failed")?;
        let elapsed = start.elapsed();

        let pdf_bytes = tokio::fs::read(&output_path)
            .await
            .context("reading rendered PDF")?;

        debug!(
            template = template_name,
            size_bytes = pdf_bytes.len(),
            elapsed_ms = elapsed.as_millis(),
            "render complete"
        );

        Ok((pdf_bytes, elapsed))
    }

    async fn exec_typst(
        &self,
        template: &Path,
        data: &Path,
        output: &Path,
    ) -> Result<()> {
        let status = Command::new("typst")
            .arg("compile")
            .arg(template)
            .arg(output)
            .arg("--input")
            .arg(format!("data_file={}", data.display()))
            .kill_on_drop(true)
            .status()
            .await
            .context("launching typst process")?;

        if !status.success() {
            let code = status.code().unwrap_or(-1);
            bail!("typst exited with code {code}");
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "renderer_test.rs"]
mod tests;
