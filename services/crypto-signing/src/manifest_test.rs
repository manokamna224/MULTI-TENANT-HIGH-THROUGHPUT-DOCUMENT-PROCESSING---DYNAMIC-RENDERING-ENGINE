/// Tests are co-located with their module and compiled only with `cargo test`.
/// They verify the manifest hash computation and QR payload round-trip.
#[cfg(test)]
mod tests {
    use super::super::manifest::DocumentManifest;

    #[test]
    fn sha256_is_deterministic_for_same_input() {
        let pdf = b"fake pdf bytes for testing";
        let m1  = DocumentManifest::new("job-1", "tenant-1", "measurement_book", pdf, "Test CA");
        let m2  = DocumentManifest::new("job-1", "tenant-1", "measurement_book", pdf, "Test CA");
        assert_eq!(m1.sha256, m2.sha256, "same input must produce same hash");
    }

    #[test]
    fn different_payloads_produce_different_hashes() {
        let m1 = DocumentManifest::new("j", "t", "mt", b"pdf v1", "CA");
        let m2 = DocumentManifest::new("j", "t", "mt", b"pdf v2", "CA");
        assert_ne!(m1.sha256, m2.sha256, "different content must differ");
    }

    #[test]
    fn qr_payload_round_trips() {
        let m   = DocumentManifest::new("job-42", "tenant-7", "measurement_book", b"data", "DocEngine CA");
        let json = m.to_qr_payload().expect("serialise should succeed");

        // Must contain key fields
        assert!(json.contains("job-42"),        "json must contain job_id");
        assert!(json.contains("tenant-7"),       "json must contain tenant_id");
        assert!(json.contains("measurement_book"), "json must contain document_type");
        assert!(json.contains(&m.sha256),        "json must contain sha256");
    }

    #[test]
    fn qr_png_is_non_empty() {
        let m  = DocumentManifest::new("j", "t", "mt", b"x", "CA");
        let png = m.render_qr_png().expect("qr render should succeed");
        assert!(!png.is_empty(), "PNG output must not be empty");
        // PNG magic bytes: 0x89 0x50 0x4E 0x47
        assert_eq!(&png[..4], b"\x89PNG", "output must be a valid PNG");
    }
}
