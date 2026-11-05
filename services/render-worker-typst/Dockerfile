# ── Build stage ──────────────────────────────────────────────────────────────
FROM rust:1.81-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
# Cache deps layer — build an empty stub first
RUN mkdir src && echo "fn main(){}" > src/main.rs && cargo build --release && rm -f target/release/render-worker-typst

COPY src ./src
RUN cargo build --release

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    # Typst CLI binary
    curl \
    # qpdf for linearization
    qpdf \
    # Font rendering
    fonts-liberation fonts-noto \
    && rm -rf /var/lib/apt/lists/*

# Install Typst CLI
RUN curl -fsSL https://github.com/typst/typst/releases/latest/download/typst-x86_64-unknown-linux-musl.tar.xz \
    | tar -xJf - --strip-components=1 -C /usr/local/bin typst-x86_64-unknown-linux-musl/typst && \
    chmod +x /usr/local/bin/typst

COPY --from=builder /app/target/release/render-worker-typst /render-worker-typst

RUN useradd -r -u 1001 -g daemon worker
USER worker

ENTRYPOINT ["/render-worker-typst"]
