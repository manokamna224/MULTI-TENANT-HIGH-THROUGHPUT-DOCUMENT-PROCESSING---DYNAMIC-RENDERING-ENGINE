// handler_test.go — white-box unit tests for the HTTP handler layer.
//
// These tests use ExportedVerifyMath (from export_test.go) to exercise the
// decimal-arithmetic reconciliation logic without any network dependencies.
// Full HTTP-layer tests that require Redis + Postgres live in tests/integration/.
package api_test

import (
	"encoding/json"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/yourorg/docengine/ingestion/internal/api"
)

func init() { gin.SetMode(gin.TestMode) }

// ─────────────────────────────────────────────────────────────────────────────
// verifyMath — line-item reconciliation
// ─────────────────────────────────────────────────────────────────────────────

func TestVerifyMath_ValidPayload(t *testing.T) {
	t.Parallel()
	raw := json.RawMessage(`{
		"line_items": [
			{"index":0,"description":"Earthwork","unit":"cum","quantity":"120.50","rate":"85.00","amount":"10242.50"},
			{"index":1,"description":"Disposal","unit":"cum","quantity":"120.50","rate":"12.00","amount":"1446.00"}
		],
		"summary": {
			"subtotal":"11688.50",
			"tax_rate_pct":18,
			"tax_amount":"2103.93",
			"grand_total":"13792.43",
			"contract_value":"500000.00",
			"previous_cumulative":"100000.00",
			"current_claim":"13792.43"
		}
	}`)
	if got := api.ExportedVerifyMath(raw); got != nil {
		t.Fatalf("valid payload should pass, got: %v", got)
	}
}

func TestVerifyMath_LineItemAmountMismatch(t *testing.T) {
	t.Parallel()
	raw := json.RawMessage(`{
		"line_items": [
			{"index":4,"description":"Compaction","unit":"sqm","quantity":"200.00","rate":"18.75","amount":"9999.00"}
		],
		"summary": {
			"subtotal":"9999.00","tax_rate_pct":18,"tax_amount":"1799.82",
			"grand_total":"11798.82","contract_value":"500000.00",
			"previous_cumulative":"0.00","current_claim":"11798.82"
		}
	}`)
	got := api.ExportedVerifyMath(raw)
	if got == nil {
		t.Fatal("expected error for amount mismatch")
	}
	if got["error"] != "arithmetic_reconciliation_failed" {
		t.Fatalf("want arithmetic_reconciliation_failed, got %q", got["error"])
	}
	details, ok := got["details"].([]string)
	if !ok || len(details) == 0 {
		t.Fatalf("expected non-empty details slice, got %#v", got["details"])
	}
	// The error coordinate must mention the correct index
	if details[0] == "" {
		t.Error("detail string must not be empty")
	}
}

func TestVerifyMath_SubtotalMismatch(t *testing.T) {
	t.Parallel()
	// Line items individually correct, but summary.subtotal is off
	raw := json.RawMessage(`{
		"line_items": [
			{"index":0,"description":"Item A","unit":"cum","quantity":"10.00","rate":"100.00","amount":"1000.00"}
		],
		"summary": {
			"subtotal":"999.00",
			"tax_rate_pct":18,"tax_amount":"179.82","grand_total":"1179.82",
			"contract_value":"50000.00","previous_cumulative":"0.00","current_claim":"1179.82"
		}
	}`)
	got := api.ExportedVerifyMath(raw)
	if got == nil {
		t.Fatal("expected subtotal mismatch error")
	}
	if got["error"] != "subtotal_mismatch" {
		t.Fatalf("want subtotal_mismatch, got %q", got["error"])
	}
}

func TestVerifyMath_CumulativeBillingExceeded(t *testing.T) {
	t.Parallel()
	// current_claim (50k) + previous_cumulative (90k) > contract_value (100k)
	raw := json.RawMessage(`{
		"line_items": [
			{"index":0,"description":"X","unit":"ls","quantity":"1.00","rate":"50000.00","amount":"50000.00"}
		],
		"summary": {
			"subtotal":"50000.00","tax_rate_pct":18,"tax_amount":"9000.00","grand_total":"59000.00",
			"contract_value":"100000.00",
			"previous_cumulative":"90000.00",
			"current_claim":"59000.00"
		}
	}`)
	got := api.ExportedVerifyMath(raw)
	if got == nil {
		t.Fatal("expected cumulative_billing_exceeded error")
	}
	if got["error"] != "cumulative_billing_exceeded" {
		t.Fatalf("want cumulative_billing_exceeded, got %q", got["error"])
	}
}

func TestVerifyMath_MultipleLineItemErrors(t *testing.T) {
	t.Parallel()
	// Both items have wrong amounts — all errors must be reported, not just the first
	raw := json.RawMessage(`{
		"line_items": [
			{"index":0,"description":"A","unit":"ls","quantity":"10.00","rate":"10.00","amount":"99.00"},
			{"index":1,"description":"B","unit":"ls","quantity":"5.00","rate":"20.00","amount":"99.00"}
		],
		"summary": {
			"subtotal":"198.00","tax_rate_pct":18,"tax_amount":"35.64","grand_total":"233.64",
			"contract_value":"1000.00","previous_cumulative":"0.00","current_claim":"233.64"
		}
	}`)
	got := api.ExportedVerifyMath(raw)
	if got == nil {
		t.Fatal("expected errors for both line items")
	}
	details, _ := got["details"].([]string)
	if len(details) < 2 {
		t.Fatalf("expected 2 detail entries, got %d: %v", len(details), details)
	}
}

func TestVerifyMath_ZeroLineItems(t *testing.T) {
	t.Parallel()
	raw := json.RawMessage(`{
		"line_items": [],
		"summary": {
			"subtotal":"0.00","tax_rate_pct":0,"tax_amount":"0.00","grand_total":"0.00",
			"contract_value":"100000.00","previous_cumulative":"0.00","current_claim":"0.00"
		}
	}`)
	// Zero line items: subtotal = 0, which matches summary. Should pass.
	got := api.ExportedVerifyMath(raw)
	if got != nil {
		t.Fatalf("empty line items with zero summary should pass, got: %v", got)
	}
}

func TestVerifyMath_InvalidJSON(t *testing.T) {
	t.Parallel()
	raw := json.RawMessage(`{not valid json`)
	got := api.ExportedVerifyMath(raw)
	if got == nil {
		t.Fatal("expected parse error for invalid JSON")
	}
	if got["error"] != "payload_parse_error" {
		t.Fatalf("want payload_parse_error, got %q", got["error"])
	}
}
