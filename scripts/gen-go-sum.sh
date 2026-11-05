#!/usr/bin/env bash
# Generates go.sum for the ingestion-engine and integration-test modules.
# Run this once after cloning, or whenever go.mod changes.
# Requires Go 1.22+ installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Generating go.sum for services/ingestion-engine"
cd "$ROOT/services/ingestion-engine"
go mod tidy

echo "==> Generating go.sum for tests/integration"
cd "$ROOT/tests/integration"
go mod tidy

echo "Done. Both go.sum files are now present."
