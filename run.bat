@echo off
SET "ROOT=D:\MULTI TENANT HIGH THROUGHPUT DOCUMENT PROCESSING & DYNAMIC RENDERING ENGINE"
SET PATH=%PATH%;C:\Program Files\Docker\Docker\resources\bin;C:\Program Files\Git\bin
SET "OUT=%ROOT%\test_results.txt"

echo ======================================================== > "%OUT%"
echo  DocEngine - Build and Test Run >> "%OUT%"
echo ======================================================== >> "%OUT%"

REM ── 1. go mod tidy ──────────────────────────────────────────
echo. >> "%OUT%"
echo [1/7] go mod tidy (ingestion-engine)... >> "%OUT%"
cd "%ROOT%\services\ingestion-engine"
go mod tidy >> "%OUT%" 2>&1
if %errorlevel% neq 0 (echo FAIL >> "%OUT%") else (echo OK >> "%OUT%")

REM ── 2. go build ─────────────────────────────────────────────
echo. >> "%OUT%"
echo [2/7] go build ./... >> "%OUT%"
go build ./... >> "%OUT%" 2>&1
if %errorlevel% neq 0 (echo FAIL >> "%OUT%") else (echo OK - compiles cleanly >> "%OUT%")

REM ── 3. go vet ───────────────────────────────────────────────
echo. >> "%OUT%"
echo [3/7] go vet ./internal/... >> "%OUT%"
go vet ./internal/... >> "%OUT%" 2>&1
if %errorlevel% neq 0 (echo FAIL >> "%OUT%") else (echo OK >> "%OUT%")

REM ── 4. go test ──────────────────────────────────────────────
echo. >> "%OUT%"
echo [4/7] go test ./internal/... >> "%OUT%"
go test ./internal/... -v -count=1 -timeout 120s >> "%OUT%" 2>&1
if %errorlevel% neq 0 (echo FAIL >> "%OUT%") else (echo PASS - all Go tests passed >> "%OUT%")

REM ── 5. cargo check render-worker-typst ──────────────────────
echo. >> "%OUT%"
echo [5/7] cargo check (render-worker-typst)... >> "%OUT%"
cd "%ROOT%\services\render-worker-typst"
cargo check >> "%OUT%" 2>&1
if %errorlevel% neq 0 (echo FAIL >> "%OUT%") else (echo OK >> "%OUT%")

REM ── 5b. cargo check crypto-signing ──────────────────────────
echo. >> "%OUT%"
echo [5b/7] cargo check (crypto-signing)... >> "%OUT%"
cd "%ROOT%\services\crypto-signing"
cargo check >> "%OUT%" 2>&1
if %errorlevel% neq 0 (echo FAIL >> "%OUT%") else (echo OK >> "%OUT%")

REM ── 6. TypeScript typecheck ──────────────────────────────────
echo. >> "%OUT%"
echo [6/7] TypeScript typecheck... >> "%OUT%"

cd "%ROOT%\services\api-gateway"
node node_modules\typescript\bin\tsc --noEmit >> "%OUT%" 2>&1
if %errorlevel% neq 0 (echo api-gateway FAIL >> "%OUT%") else (echo api-gateway OK >> "%OUT%")

cd "%ROOT%\services\render-worker-chromium"
node node_modules\typescript\bin\tsc --noEmit >> "%OUT%" 2>&1
if %errorlevel% neq 0 (echo render-worker-chromium FAIL >> "%OUT%") else (echo render-worker-chromium OK >> "%OUT%")

cd "%ROOT%\services\artifact-storage"
node node_modules\typescript\bin\tsc --noEmit >> "%OUT%" 2>&1
if %errorlevel% neq 0 (echo artifact-storage FAIL >> "%OUT%") else (echo artifact-storage OK >> "%OUT%")

REM ── 7. Docker check ─────────────────────────────────────────
echo. >> "%OUT%"
echo [7/7] Docker status... >> "%OUT%"
docker info >> "%OUT%" 2>&1
if %errorlevel% neq 0 (echo Docker NOT running >> "%OUT%") else (echo Docker OK >> "%OUT%")

echo. >> "%OUT%"
echo ======================================================== >> "%OUT%"
echo  DONE >> "%OUT%"
echo ======================================================== >> "%OUT%"

type "%OUT%"
