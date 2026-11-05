// Package math implements zero-drift arithmetic verification for financial documents.
// All calculations use shopspring/decimal (base-10 fixed-point) to eliminate
// IEEE-754 floating-point rounding errors in line-item reconciliation.
package math

import (
	"fmt"

	"github.com/shopspring/decimal"
)

// LineItem represents a single row in a measurement book or schedule of rates.
type LineItem struct {
	Index       int             `json:"index"`
	Description string          `json:"description"`
	Quantity    decimal.Decimal `json:"quantity"`
	Unit        string          `json:"unit"`
	Rate        decimal.Decimal `json:"rate"`
	Amount      decimal.Decimal `json:"amount"` // claimed value from payload
}

// TaxTier defines a tiered tax band (e.g. GST slabs).
type TaxTier struct {
	UpTo    decimal.Decimal // upper bound (inclusive); zero means unbounded
	RatePct decimal.Decimal // percentage, e.g. 18 for 18%
}

// VerificationError pinpoints exactly which field failed reconciliation.
type VerificationError struct {
	Path     string          // e.g. "line_items[4].amount_mismatch"
	Expected decimal.Decimal
	Got      decimal.Decimal
	Delta    decimal.Decimal
}

func (e *VerificationError) Error() string {
	return fmt.Sprintf("reconciliation failure at %s: expected %s, got %s (delta %s)",
		e.Path, e.Expected.String(), e.Got.String(), e.Delta.String())
}

// VerifyLineItems reconciles every line item's Amount against Quantity × Rate.
// Returns all errors found — not just the first — so callers get complete diagnostics.
func VerifyLineItems(items []LineItem) []VerificationError {
	var errs []VerificationError

	for _, item := range items {
		computed := item.Quantity.Mul(item.Rate).RoundBank(2)
		if !computed.Equal(item.Amount) {
			errs = append(errs, VerificationError{
				Path:     fmt.Sprintf("line_items[%d].amount_mismatch", item.Index),
				Expected: computed,
				Got:      item.Amount,
				Delta:    item.Amount.Sub(computed).Abs(),
			})
		}
	}

	return errs
}

// ComputeSubtotal sums the verified amounts of all line items.
func ComputeSubtotal(items []LineItem) decimal.Decimal {
	total := decimal.Zero
	for _, item := range items {
		total = total.Add(item.Amount)
	}
	return total.RoundBank(2)
}

// ApplyTieredTax calculates tax on a given base amount using ordered tiers.
// Tiers are evaluated in order; the first tier whose UpTo >= amount (or UpTo == 0)
// determines the applicable rate.
func ApplyTieredTax(base decimal.Decimal, tiers []TaxTier) (taxAmount, grandTotal decimal.Decimal) {
	for _, tier := range tiers {
		if tier.UpTo.IsZero() || base.LessThanOrEqual(tier.UpTo) {
			taxAmount = base.Mul(tier.RatePct).Div(decimal.NewFromInt(100)).RoundBank(2)
			grandTotal = base.Add(taxAmount).RoundBank(2)
			return
		}
	}
	// No tier matched — zero tax
	return decimal.Zero, base
}

// CumulativeBillingCheck validates that the cumulative previous claim plus
// the current claim does not exceed the contract value.
func CumulativeBillingCheck(contractValue, previousCumulative, currentClaim decimal.Decimal) error {
	newCumulative := previousCumulative.Add(currentClaim)
	if newCumulative.GreaterThan(contractValue) {
		return &VerificationError{
			Path:     "cumulative_billing.exceeds_contract_value",
			Expected: contractValue,
			Got:      newCumulative,
			Delta:    newCumulative.Sub(contractValue),
		}
	}
	return nil
}
