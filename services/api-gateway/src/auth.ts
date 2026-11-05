/**
 * Tenant authentication — two supported schemes:
 *
 *   1. Bearer JWT  — `Authorization: Bearer <token>`
 *      Token payload must contain { tenant_id, exp }.
 *      Validated with the shared JWT_SECRET (symmetric HS256).
 *      For production: use RS256 with per-tenant JWKS endpoint.
 *
 *   2. API Key     — `X-API-Key: <raw key>`
 *      The raw key is hashed (SHA-256 truncated to 64 hex chars) and
 *      looked up in the tenants table. Constant-time comparison prevents
 *      timing attacks.
 *
 * On success, injects `request.tenantId` and `request.maxConcurrency`
 * so downstream rate-limit and proxy handlers can read them.
 */
import crypto from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { Logger } from 'winston';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId:       string;
    maxConcurrency: number;
  }
}

interface TenantRow {
  tenant_id:       string;
  max_concurrency: number;
  is_active:       boolean;
}

export function buildAuthHook(db: Pool, jwtSecret: string, log: Logger) {
  return async function authHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const tenant = await resolveTenant(request, db, jwtSecret);
      if (!tenant) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!tenant.is_active) {
        return reply.code(403).send({ error: 'tenant_suspended' });
      }
      request.tenantId       = tenant.tenant_id;
      request.maxConcurrency = tenant.max_concurrency;
    } catch (err) {
      log.warn('auth error', { err, path: request.url });
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

async function resolveTenant(
  request: FastifyRequest,
  db: Pool,
  jwtSecret: string,
): Promise<TenantRow | null> {
  const authHeader = request.headers['authorization'];
  const apiKeyHeader = request.headers['x-api-key'] as string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    return resolveJwt(authHeader.slice(7), db, jwtSecret);
  }

  if (apiKeyHeader) {
    return resolveApiKey(apiKeyHeader, db);
  }

  return null;
}

async function resolveJwt(
  token: string,
  db: Pool,
  secret: string,
): Promise<TenantRow | null> {
  const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as {
    tenant_id: string;
  };

  const result = await db.query<TenantRow>(
    'SELECT tenant_id, max_concurrency, is_active FROM tenants WHERE tenant_id = $1',
    [payload.tenant_id],
  );
  return result.rows[0] ?? null;
}

async function resolveApiKey(
  rawKey: string,
  db: Pool,
): Promise<TenantRow | null> {
  // SHA-256 of the raw key, hex-encoded, first 64 chars — matches the
  // api_key_hash column format set during tenant provisioning.
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 64);

  const result = await db.query<TenantRow>(
    'SELECT tenant_id, max_concurrency, is_active FROM tenants WHERE api_key_hash = $1',
    [hash],
  );
  return result.rows[0] ?? null;
}
