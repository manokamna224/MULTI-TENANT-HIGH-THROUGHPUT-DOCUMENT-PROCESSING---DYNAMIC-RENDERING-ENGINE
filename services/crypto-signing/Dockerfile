# ── Build stage ──────────────────────────────────────────────────────────────
FROM rust:1.81-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main(){}" > src/main.rs && \
    cargo build --release && \
    rm -f target/release/crypto-signing

COPY src ./src
RUN cargo build --release

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    # qpdf for linearization
    qpdf \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/crypto-signing /crypto-signing

RUN useradd -r -u 1001 -g daemon worker
USER worker

ENTRYPOINT ["/crypto-signing"]
