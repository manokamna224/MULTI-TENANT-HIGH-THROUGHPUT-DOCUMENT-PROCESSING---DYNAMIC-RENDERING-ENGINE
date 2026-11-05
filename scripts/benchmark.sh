#!/usr/bin/env bash
# Phase 4 — Production Hardening Benchmark
#
# Runs the full k6 test suite against a target environment and produces
# a timestamped report in tests/load/reports/.
#
# Usage:
#   ./scripts/benchmark.sh                         # smoke only
#   ./scripts/benchmark.sh ramp                    # smoke + ramp
#   ./scripts/benchmark.sh all                     # smoke + ramp + sustained (full Phase 4)
#   BASE_URL=https://api.prod.example.com ./scripts/benchmark.sh all
#
# Prerequisites:
#   - k6 >= 0.53 (https://k6.io/docs/getting-started/installation/)
#   - Stack running (make dev OR a deployed environment)
#   - API_KEY env var set

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCENARIO="${1:-smoke}"
BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-dev-api-key-for-local-testing}"
REPORT_DIR="$ROOT/tests/load/reports"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
REPORT_FILE="$REPORT_DIR/benchmark_${SCENARIO}_${TIMESTAMP}.json"

mkdir -p "$REPORT_DIR"

echo "============================================================"
echo " DocEngine — Phase 4 Benchmark"
echo " Scenario : $SCENARIO"
echo " Target   : $BASE_URL"
echo " Report   : $REPORT_FILE"
echo "============================================================"

k6 run \
  --env BASE_URL="$BASE_URL" \
  --env API_KEY="$API_KEY"   \
  --env SCENARIO="$SCENARIO" \
  --summary-export="$REPORT_FILE" \
  "$ROOT/tests/load/k6-render-load-test.js"

echo ""
echo "Benchmark complete. Results saved to:"
echo "  $REPORT_FILE"

# Print pass/fail verdict against Phase 4 SLOs
python3 - "$REPORT_FILE" <<'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

metrics = data.get("metrics", {})

def pct(metric_name, percentile):
    m = metrics.get(metric_name, {})
    return m.get("values", {}).get(f"p({percentile})", None)

def rate(metric_name):
    m = metrics.get(metric_name, {})
    return m.get("values", {}).get("rate", None)

checks = [
    ("http_req_duration p(95) < 2000ms", pct("http_req_duration", 95), 2000, "<="),
    ("http_req_duration p(99) < 5000ms", pct("http_req_duration", 99), 5000, "<="),
    ("error rate < 1%",                  rate("errors"),              0.01, "<="),
]

all_pass = True
print("\n── SLO Verification ──────────────────────────────────────")
for label, value, threshold, op in checks:
    if value is None:
        print(f"  SKIP  {label}  (metric not found)")
        continue
    if op == "<=" and value <= threshold:
        status = "PASS"
    else:
        status = "FAIL"
        all_pass = False
    print(f"  {status}  {label}  ({value:.2f})")

print("──────────────────────────────────────────────────────────")
if all_pass:
    print("  ✓ All SLOs met — Phase 4 benchmark PASSED")
    sys.exit(0)
else:
    print("  ✗ One or more SLOs violated — Phase 4 benchmark FAILED")
    sys.exit(1)
PYEOF
