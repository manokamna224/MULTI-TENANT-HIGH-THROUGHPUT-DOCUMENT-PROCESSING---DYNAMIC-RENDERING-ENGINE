/**
 * Fastify application factory.
 *
 * Plugin registration order matters in Fastify:
 *   1. Rate limiter (needs Redis — registers before route plugins)
 *   2. Auth preHandler hook (runs after rate-limit, before proxy)
 *   3. Header-injection onRequest hook (stamps X-Tenant-ID before upstream sees it)
 *   4. HTTP proxy (forwards /v1/* to ingestion-engine)
 *   5. Local /healthz route (no auth, no proxy)
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import httpProxy from '@fastify/http-proxy';
import rateLimit  from '@fastify/rate-limit';
import { Pool }   from 'pg';
import Redis      from 'ioredis';
import { Logger } from 'winston';
import { Config } from './config';
import { buildAuthHook } from './auth';

export async function buildApp(cfg: Config, log: Logger): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });

  const db    = new Pool({ connectionString: cfg.databaseUrl, max: 10 });
  const redis = new Redis(cfg.redisUrl, { lazyConnect: true });
  await redis.connect();

  // ── 1. Rate limiting ──────────────────────────────────────────────────────
  // Keyed on resolved tenantId (set by auth hook). Falls back to IP for the
  // /healthz route where auth doesn't run.
  await app.register(rateLimit, {
    global:     true,
    max:        cfg.rateLimitMax,
    timeWindow: cfg.rateLimitWindowMs,
    redis,
    keyGenerator: (request: FastifyRequest) =>
      (request as any).tenantId ?? request.ip,
    errorResponseBuilder: (_req: FastifyRequest, context: any) => ({
      error:      'rate_limit_exceeded',
      limit:      context.max,
      remaining:  0,
      retryAfter: context.ttl,
    }),
  });

  // ── 2. Auth preHandler hook ───────────────────────────────────────────────
  const authHook = buildAuthHook(db, cfg.jwtSecret, log);

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for the local health check
    if (request.routerPath === '/healthz') return;
    return authHook(request, reply);
  });

  // ── 3. Tenant header injection ────────────────────────────────────────────
  // Runs after auth so tenantId is already resolved on the request object.
  // Injects headers that the ingestion-engine reads to avoid redundant DB lookups.
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const tid = (request as any).tenantId;
    const mc  = (request as any).maxConcurrency;
    if (tid) {
      request.headers['x-tenant-id']       = tid;
      request.headers['x-max-concurrency'] = String(mc ?? 10);
    }
  });

  // ── 4. Transparent reverse proxy to ingestion-engine ─────────────────────
  await app.register(httpProxy, {
    upstream:      cfg.upstreamUrl,
    prefix:        '/v1',
    rewritePrefix: '/v1',
    httpMethods:   ['GET', 'POST', 'DELETE', 'PATCH'],
  });

  // ── 5. Local health check (no upstream call needed) ───────────────────────
  app.get('/healthz', async () => ({
    status:  'ok',
    service: 'api-gateway',
    uptime:  process.uptime(),
  }));

  // ── Cleanup on close ─────────────────────────────────────────────────────
  app.addHook('onClose', async () => {
    await db.end();
    redis.disconnect();
    log.info('api-gateway connections closed');
  });

  return app;
}
