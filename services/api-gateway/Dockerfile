# ── Build ────────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json .
COPY src ./src
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json .
RUN useradd -r -u 1001 worker && chown -R worker /app
USER worker
EXPOSE 3000
CMD ["node", "dist/index.js"]
