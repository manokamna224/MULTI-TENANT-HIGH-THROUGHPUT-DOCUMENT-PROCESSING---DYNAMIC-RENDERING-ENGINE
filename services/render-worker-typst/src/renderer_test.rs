#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use crate::renderer::TypstRenderer;

    /// Smoke-test that the renderer errors clearly when the template is missing,
    /// rather than panicking or producing a zero-byte file.
    #[tokio::test]
    async fn missing_template_returns_error() {
        let renderer = TypstRenderer::new("/nonexistent/templates");
        let result   = renderer.render("nonexistent_template", "{}").await;
        assert!(result.is_err(), "expected error for missing template");
        let msg = format!("{}", result.unwrap_err());
        assert!(
            msg.contains("template not found"),
            "error message should mention 'template not found', got: {msg}"
        );
    }
}
