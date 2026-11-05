# ── Build stage ───────────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Copy go.mod first; go.sum is optional — go mod download creates it if absent.
COPY go.mod ./
# Copy go.sum only when it exists (use || true so missing file doesn't abort)
COPY go.su[m] ./

RUN go mod download

COPY . .

# go mod tidy generates go.sum if not present; then build
RUN go mod tidy && \
    CGO_ENABLED=0 GOOS=linux go build \
      -ldflags="-s -w -X main.version=$(git describe --tags --always 2>/dev/null || echo dev)" \
      -o /bin/ingestion-engine .

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /bin/ingestion-engine /ingestion-engine
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

EXPOSE 8080
ENTRYPOINT ["/ingestion-engine"]
