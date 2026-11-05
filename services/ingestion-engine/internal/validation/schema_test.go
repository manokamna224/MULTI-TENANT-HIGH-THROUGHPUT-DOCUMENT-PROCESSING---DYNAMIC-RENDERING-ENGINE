package validation_test

import (
	"encoding/json"
	"testing"

	"github.com/yourorg/docengine/ingestion/internal/validation"
)

func TestNew_LoadsSchemas(t *testing.T) {
	v, err := validation.New()
	if err != nil {
		t.Fatalf("validation.New() failed: %v", err)
	}
	types := v.KnownDocTypes()
	if len(types) == 0 {
		t.Fatal("expected at least one loaded schema")
	}
	// All three financial schemas must be present
	want := map[string]bool{
		"measurement_book":  false,
		"schedule_of_rates": false,
		"cumulative_billing": false,
	}
	for _, dt := range types {
		want[dt] = true
	}
	for dt, found := range want {
		if !found {
			t.Errorf("schema %q not loaded; loaded: %v", dt, types)
		}
	}
}

func TestValidate_MeasurementBook_Valid(t *testing.T) {
	v, _ := validation.New()
	payload := json.RawMessage(`{
		"document_meta": {
			"title": "T", "contract_no": "C",
			"contractor": "X", "work_description": "W",
			"date": "2026-11-04"
		},
		"line_items": [
			{"index": 0, "description": "EW", "unit": "cum",
			 "quantity": "10.00", "rate": "100.00", "amount": "1000.00"}
		],
		"summary": {
			"subtotal": "1000.00", "tax_rate_pct": 18,
			"tax_amount": "180.00", "grand_total": "1180.00",
			"contract_value": "50000.00",
			"previous_cumulative": "0.00",
			"current_claim": "1180.00"
		}
	}`)
	if err := v.Validate("measurement_book", payload); err != nil {
		t.Fatalf("valid payload should pass schema validation: %v", err)
	}
}

func TestValidate_MeasurementBook_MissingRequiredField(t *testing.T) {
	v, _ := validation.New()
	// Missing document_meta.contract_no
	payload := json.RawMessage(`{
		"document_meta": {
			"title": "T",
			"contractor": "X", "work_description": "W",
			"date": "2026-11-04"
		},
		"line_items": [],
		"summary": {
			"subtotal":"0.00","tax_rate_pct":0,"tax_amount":"0.00",
			"grand_total":"0.00","contract_value":"100.00",
			"previous_cumulative":"0.00","current_claim":"0.00"
		}
	}`)
	if err := v.Validate("measurement_book", payload); err == nil {
		t.Fatal("expected schema validation error for missing contract_no")
	}
}

func TestValidate_MeasurementBook_InvalidDateFormat(t *testing.T) {
	v, _ := validation.New()
	payload := json.RawMessage(`{
		"document_meta": {
			"title": "T", "contract_no": "C",
			"contractor": "X", "work_description": "W",
			"date": "04-11-2026"
		},
		"line_items": [],
		"summary": {
			"subtotal":"0.00","tax_rate_pct":0,"tax_amount":"0.00",
			"grand_total":"0.00","contract_value":"100.00",
			"previous_cumulative":"0.00","current_claim":"0.00"
		}
	}`)
	if err := v.Validate("measurement_book", payload); err == nil {
		t.Fatal("expected schema validation error for invalid date format (DD-MM-YYYY)")
	}
}

func TestValidate_UnknownDocType_PassesThrough(t *testing.T) {
	v, _ := validation.New()
	// Unknown types have no schema — they pass through without error
	if err := v.Validate("custom_invoice", json.RawMessage(`{"any":"field"}`)); err != nil {
		t.Fatalf("unknown doc type should pass through, got: %v", err)
	}
}

func TestValidate_InvalidJSON_ReturnsError(t *testing.T) {
	v, _ := validation.New()
	if err := v.Validate("measurement_book", json.RawMessage(`{not json`)); err == nil {
		t.Fatal("invalid JSON should return an error")
	}
}

func TestValidate_ScheduleOfRates_Valid(t *testing.T) {
	v, _ := validation.New()
	payload := json.RawMessage(`{
		"document_meta": { "title": "SOR 2026", "financial_year": "2026-27" },
		"sections": [
			{
				"name": "Earthwork",
				"items": [
					{"code":"EW-001","description":"Excavation","unit":"cum","rate":"85.00"}
				]
			}
		]
	}`)
	if err := v.Validate("schedule_of_rates", payload); err != nil {
		t.Fatalf("valid schedule_of_rates payload failed: %v", err)
	}
}

func TestValidate_AmountPattern_RejectsFloat(t *testing.T) {
	v, _ := validation.New()
	// amount field must match ^\d+(\.\d{1,2})?$ — "10242.500" has 3dp
	payload := json.RawMessage(`{
		"document_meta": {
			"title": "T", "contract_no": "C",
			"contractor": "X", "work_description": "W",
			"date": "2026-11-04"
		},
		"line_items": [
			{"index": 0, "description": "EW", "unit": "cum",
			 "quantity": "10.00", "rate": "100.00", "amount": "10242.500"}
		],
		"summary": {
			"subtotal":"10242.500","tax_rate_pct":18,
			"tax_amount":"1843.65","grand_total":"12086.15",
			"contract_value":"50000.00","previous_cumulative":"0.00",
			"current_claim":"12086.15"
		}
	}`)
	if err := v.Validate("measurement_book", payload); err == nil {
		t.Fatal("expected schema error for amount with 3 decimal places")
	}
}
