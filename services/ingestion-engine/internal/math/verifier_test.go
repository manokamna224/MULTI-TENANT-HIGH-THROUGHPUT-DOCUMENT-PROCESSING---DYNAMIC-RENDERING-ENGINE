package math_test

import (
	"testing"

	"github.com/shopspring/decimal"
	"github.com/yourorg/docengine/ingestion/internal/math"
)

// ── VerifyLineItems ────────────────────────────────────────────────────────────

func TestVerifyLineItems_Valid(t *testing.T) {
	t.Parallel()
	items := []math.LineItem{
		{Index: 0, Quantity: decimal.NewFromFloat(10.5), Rate: decimal.NewFromFloat(120.00), Amount: decimal.NewFromFloat(1260.00)},
		{Index: 1, Quantity: decimal.NewFromFloat(3), Rate: decimal.NewFromFloat(450.75), Amount: decimal.NewFromFloat(1352.25)},
	}
	if errs := math.VerifyLineItems(items); len(errs) != 0 {
		t.Fatalf("expected 0 errors, got %d: %v", len(errs), errs)
	}
}

func TestVerifyLineItems_SingleMismatch(t *testing.T) {
	t.Parallel()
	items := []math.LineItem{
		{Index: 4, Quantity: decimal.NewFromFloat(10), Rate: decimal.NewFromFloat(100), Amount: decimal.NewFromFloat(999)},
	}
	errs := math.VerifyLineItems(items)
	if len(errs) != 1 {
		t.Fatalf("expected 1 error, got %d", len(errs))
	}
	if errs[0].Path != "line_items[4].amount_mismatch" {
		t.Errorf("unexpected error path: %s", errs[0].Path)
	}
}

func TestVerifyLineItems_AllErrors(t *testing.T) {
	t.Parallel()
	items := []math.LineItem{
		{Index: 0, Quantity: decimal.NewFromFloat(1), Rate: decimal.NewFromFloat(100), Amount: decimal.NewFromFloat(99)},
		{Index: 1, Quantity: decimal.NewFromFloat(2), Rate: decimal.NewFromFloat(50), Amount: decimal.NewFromFloat(99)},
	}
	errs := math.VerifyLineItems(items)
	if len(errs) != 2 {
		t.Fatalf("expected 2 errors (one per item), got %d", len(errs))
	}
}

func TestVerifyLineItems_Empty(t *testing.T) {
	t.Parallel()
	if errs := math.VerifyLineItems(nil); len(errs) != 0 {
		t.Fatalf("expected 0 errors for empty input, got %d", len(errs))
	}
}

func TestVerifyLineItems_BankersRounding(t *testing.T) {
	t.Parallel()
	// 120.50 × 85.00 = 10242.50 (exact, no rounding needed)
	items := []math.LineItem{
		{
			Index:    0,
			Quantity: decimal.RequireFromString("120.50"),
			Rate:     decimal.RequireFromString("85.00"),
			Amount:   decimal.RequireFromString("10242.50"),
		},
	}
	if errs := math.VerifyLineItems(items); len(errs) != 0 {
		t.Fatalf("expected 0 errors, got %v", errs)
	}
}

// ── ComputeSubtotal ────────────────────────────────────────────────────────────

func TestComputeSubtotal_SumsAmounts(t *testing.T) {
	t.Parallel()
	items := []math.LineItem{
		{Amount: decimal.RequireFromString("1000.00")},
		{Amount: decimal.RequireFromString("500.50")},
		{Amount: decimal.RequireFromString("249.50")},
	}
	got := math.ComputeSubtotal(items)
	want := decimal.RequireFromString("1750.00")
	if !got.Equal(want) {
		t.Errorf("want %s, got %s", want, got)
	}
}

func TestComputeSubtotal_Empty(t *testing.T) {
	t.Parallel()
	got := math.ComputeSubtotal(nil)
	if !got.Equal(decimal.Zero) {
		t.Errorf("expected zero for empty items, got %s", got)
	}
}

// ── ApplyTieredTax ─────────────────────────────────────────────────────────────

func TestApplyTieredTax_GST18(t *testing.T) {
	t.Parallel()
	tiers := []math.TaxTier{
		{UpTo: decimal.Zero, RatePct: decimal.NewFromInt(18)},
	}
	tax, total := math.ApplyTieredTax(decimal.NewFromFloat(10000), tiers)
	if tax.String() != "1800" {
		t.Errorf("expected tax 1800, got %s", tax)
	}
	if total.String() != "11800" {
		t.Errorf("expected total 11800, got %s", total)
	}
}

func TestApplyTieredTax_MultiTier_LowerBand(t *testing.T) {
	t.Parallel()
	// Base 5000: falls into 5% tier (≤ 10000)
	tiers := []math.TaxTier{
		{UpTo: decimal.NewFromFloat(10000), RatePct: decimal.NewFromFloat(5)},
		{UpTo: decimal.Zero,                RatePct: decimal.NewFromFloat(18)},
	}
	tax, total := math.ApplyTieredTax(decimal.NewFromFloat(5000), tiers)
	if tax.String() != "250" {
		t.Errorf("expected tax 250, got %s", tax)
	}
	if total.String() != "5250" {
		t.Errorf("expected total 5250, got %s", total)
	}
}

func TestApplyTieredTax_MultiTier_UpperBand(t *testing.T) {
	t.Parallel()
	// Base 50000: exceeds 10000 threshold → 18% tier
	tiers := []math.TaxTier{
		{UpTo: decimal.NewFromFloat(10000), RatePct: decimal.NewFromFloat(5)},
		{UpTo: decimal.Zero,                RatePct: decimal.NewFromFloat(18)},
	}
	tax, total := math.ApplyTieredTax(decimal.NewFromFloat(50000), tiers)
	if tax.String() != "9000" {
		t.Errorf("expected tax 9000, got %s", tax)
	}
	if total.String() != "59000" {
		t.Errorf("expected total 59000, got %s", total)
	}
}

func TestApplyTieredTax_NoTiers_ZeroTax(t *testing.T) {
	t.Parallel()
	_, total := math.ApplyTieredTax(decimal.NewFromFloat(1000), nil)
	if total.String() != "1000" {
		t.Errorf("expected total = base when no tiers, got %s", total)
	}
}

// ── CumulativeBillingCheck ─────────────────────────────────────────────────────

func TestCumulativeBillingCheck_WithinLimit(t *testing.T) {
	t.Parallel()
	err := math.CumulativeBillingCheck(
		decimal.NewFromFloat(100000),
		decimal.NewFromFloat(50000),
		decimal.NewFromFloat(30000), // 80000 total — within limit
	)
	if err != nil {
		t.Fatalf("expected nil for valid cumulative, got: %v", err)
	}
}

func TestCumulativeBillingCheck_ExactLimit(t *testing.T) {
	t.Parallel()
	// previous + current == contract → exactly at limit, should pass
	err := math.CumulativeBillingCheck(
		decimal.NewFromFloat(100000),
		decimal.NewFromFloat(70000),
		decimal.NewFromFloat(30000), // 100000 == contract_value
	)
	if err != nil {
		t.Fatalf("expected nil when cumulative equals contract value, got: %v", err)
	}
}

func TestCumulativeBillingCheck_Overage(t *testing.T) {
	t.Parallel()
	err := math.CumulativeBillingCheck(
		decimal.NewFromFloat(100000),
		decimal.NewFromFloat(90000),
		decimal.NewFromFloat(15000), // 105000 > 100000
	)
	if err == nil {
		t.Fatal("expected error for overage, got nil")
	}
}

func TestCumulativeBillingCheck_ZeroPrevious(t *testing.T) {
	t.Parallel()
	// First bill: previous = 0
	err := math.CumulativeBillingCheck(
		decimal.NewFromFloat(500000),
		decimal.Zero,
		decimal.NewFromFloat(20000),
	)
	if err != nil {
		t.Fatalf("expected nil for first bill, got: %v", err)
	}
}
