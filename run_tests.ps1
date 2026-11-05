$ErrorActionPreference = "Continue"
$env:PATH += ';C:\Program Files\Docker\Docker\resources\bin;C:\Program Files\Git\bin'

$ROOT = Split-Path $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "========================================================"
Write-Host " DocEngine - Full Test Run"
Write-Host "========================================================"

# ── 1. Go mod tidy ────────────────────────────────────────────────
Write-Host ""
Write-Host "[1/6] go mod tidy (ingestion-engine)..."
Set-Location "$ROOT\services\ingestion-engine"
$out = go mod tidy 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "FAIL: $out" } else { Write-Host "OK" }

# ── 2. Go build ──────────────────────────────────────────────────
Write-Host ""
Write-Host "[2/6] go build (ingestion-engine)..."
$out = go build ./... 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL (build errors):"
    $out | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "OK - compiles cleanly"
}

# ── 3. Go test ──────────────────────────────────────────────────
Write-Host ""
Write-Host "[3/6] go test ./internal/... (ingestion-engine)..."
$out = go test ./internal/... -v -count=1 -timeout 120s 2>&1
$exitCode = $LASTEXITCODE
$out | ForEach-Object { Write-Host "  $_" }
if ($exitCode -ne 0) { Write-Host "FAIL (exit $exitCode)" } else { Write-Host "PASS" }

# ── 4. Rust build (typst worker) ─────────────────────────────────
Write-Host ""
Write-Host "[4/6] cargo check (render-worker-typst)..."
Set-Location "$ROOT\services\render-worker-typst"
$out = cargo check 2>&1
$exitCode = $LASTEXITCODE
$out | Select-Object -Last 20 | ForEach-Object { Write-Host "  $_" }
if ($exitCode -ne 0) { Write-Host "FAIL (exit $exitCode)" } else { Write-Host "OK" }

# ── 5. Rust build (crypto-signing) ───────────────────────────────
Write-Host ""
Write-Host "[5/6] cargo check (crypto-signing)..."
Set-Location "$ROOT\services\crypto-signing"
$out = cargo check 2>&1
$exitCode = $LASTEXITCODE
$out | Select-Object -Last 20 | ForEach-Object { Write-Host "  $_" }
if ($exitCode -ne 0) { Write-Host "FAIL (exit $exitCode)" } else { Write-Host "OK" }

# ── 6. TypeScript typecheck (all 3 TS services) ──────────────────
Write-Host ""
Write-Host "[6/6] TypeScript typecheck (api-gateway, chromium-worker, artifact-storage)..."
$tsServices = @("api-gateway", "render-worker-chromium", "artifact-storage")
foreach ($svc in $tsServices) {
    $svcPath = "$ROOT\services\$svc"
    $tsc = "$svcPath\node_modules\typescript\bin\tsc"
    if (-not (Test-Path $tsc)) {
        Write-Host "  $svc - SKIP (node_modules not installed)"
        continue
    }
    $out = node $tsc --noEmit --project "$svcPath\tsconfig.json" 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Host "  $svc - FAIL:"
        $out | ForEach-Object { Write-Host "    $_" }
    } else {
        Write-Host "  $svc - OK"
    }
}

# ── 7. Docker check ──────────────────────────────────────────────
Write-Host ""
Write-Host "[7] Docker Desktop status..."
$out = docker info 2>&1 | Select-Object -First 3
$out | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Docker not running - start Docker Desktop first"
} else {
    Write-Host "  Docker running - OK"
}

Write-Host ""
Write-Host "========================================================"
Write-Host " Done."
Write-Host "========================================================"
