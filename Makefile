# DocEngine — top-level Makefile
# ─────────────────────────────────────────────────────────────────────────────
# Key targets:
#   make dev              — start full local stack
#   make dev-down         — stop stack (keep volumes)
#   make dev-destroy      — stop stack + delete volumes
#   make gen-certs        — generate dev self-signed certificates
#   make gen-go-sum       — generate go.sum files for Go modules
#   make test-go          — Go unit tests (ingestion-engine)
#   make test-go-race     — Go unit tests with -race detector
#   make test-integration — Go integration tests (requires Docker)
#   make test-rust        — Rust unit tests (all Rust services)
#   make test-ts          — TypeScript unit tests (all TS services)
#   make test-all         — run every test suite
#   make test-load        — k6 smoke test against local stack
#   make benchmark        — Phase 4 full benchmark (smoke+ramp+sustained)
#   make build-all        — build all Docker images
#   make lint-go          — go vet ingestion-engine
#   make lint-ts          — tsc --noEmit all TS services
#   make k8s-templates    — push templates into k8s ConfigMaps
#   make k8s-apply        — apply all k8s manifests
#   make smoke            — curl a test render to local stack
# ─────────────────────────────────────────────────────────────────────────────

ROOT         := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))
COMPOSE_FILE := $(ROOT)infra/docker/docker-compose.yml
INGESTION    := $(ROOT)services/ingestion-engine
TYPST        := $(ROOT)services/render-worker-typst
SIGNING      := $(ROOT)services/crypto-signing
CHROMIUM     := $(ROOT)services/render-worker-chromium
GATEWAY      := $(ROOT)services/api-gateway
ARTIFACT     := $(ROOT)services/artifact-storage

.PHONY: dev dev-down dev-destroy dev-logs gen-certs gen-go-sum \
        test-go test-go-race test-integration test-rust test-ts test-all \
        test-load benchmark build-all lint-go lint-ts \
        k8s-templates k8s-apply smoke

# ── Local stack ───────────────────────────────────────────────────────────────

dev:
	docker compose -f $(COMPOSE_FILE) up --build -d
	@echo ""
	@echo "  ✓ Stack running"
	@echo "    API Gateway  → http://localhost:3000"
	@echo "    MinIO UI     → http://localhost:9001  (minioadmin / minioadmin)"
	@echo "    PostgreSQL   → localhost:5432          (docengine / devpassword)"

dev-down:
	docker compose -f $(COMPOSE_FILE) down

dev-destroy:
	docker compose -f $(COMPOSE_FILE) down -v

dev-logs:
	docker compose -f $(COMPOSE_FILE) logs -f

# ── One-time setup ────────────────────────────────────────────────────────────

gen-certs:
	bash $(ROOT)dev-certs/generate.sh

gen-go-sum:
	bash $(ROOT)scripts/gen-go-sum.sh

# ── Tests ─────────────────────────────────────────────────────────────────────

test-go:
	cd $(INGESTION) && go test ./internal/... -v -count=1 -timeout 60s

test-go-race:
	cd $(INGESTION) && go test ./internal/... -v -count=1 -race -timeout 60s

test-integration:
	cd $(ROOT)tests/integration && go test ./... -v -tags integration -timeout 180s

test-rust:
	cd $(TYPST)   && cargo test
	cd $(SIGNING) && cargo test

test-ts:
	cd $(CHROMIUM) && npm ci --prefer-offline && npm test
	cd $(GATEWAY)  && npm ci --prefer-offline && npm test
	cd $(ARTIFACT) && npm ci --prefer-offline && npm test

test-all: test-go-race test-rust test-ts test-integration

# ── Load testing & benchmarking ───────────────────────────────────────────────

test-load:
	k6 run $(ROOT)tests/load/k6-render-load-test.js \
	    --env BASE_URL=http://localhost:3000 \
	    --env API_KEY=dev-api-key-for-local-testing \
	    --env SCENARIO=smoke

benchmark:
	BASE_URL=http://localhost:3000 \
	API_KEY=dev-api-key-for-local-testing \
	bash $(ROOT)scripts/benchmark.sh all

# ── Build ─────────────────────────────────────────────────────────────────────

build-all:
	docker compose -f $(COMPOSE_FILE) build --no-cache

# ── Linting ───────────────────────────────────────────────────────────────────

lint-go:
	cd $(INGESTION) && go vet ./...

lint-ts:
	cd $(CHROMIUM) && npm run typecheck
	cd $(GATEWAY)  && npm run typecheck
	cd $(ARTIFACT) && npm run typecheck

# ── Kubernetes ────────────────────────────────────────────────────────────────

k8s-templates:
	kubectl create configmap typst-templates -n docengine \
	  --from-file=$(ROOT)templates/typst/ \
	  --dry-run=client -o yaml | kubectl apply -f -
	kubectl create configmap html-templates -n docengine \
	  --from-file=$(ROOT)templates/html/ \
	  --dry-run=client -o yaml | kubectl apply -f -

k8s-apply:
	kubectl apply -f $(ROOT)infra/k8s/ -n docengine

# ── Smoke test ────────────────────────────────────────────────────────────────

smoke:
	curl -s -X POST http://localhost:3000/v1/render \
	  -H "Content-Type: application/json" \
	  -H "X-API-Key: dev-api-key-for-local-testing" \
	  -d @$(ROOT)docs/sample-payload.json | jq .
