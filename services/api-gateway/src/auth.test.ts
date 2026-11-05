/**
 * Unit tests for auth.ts — tenant authentication helpers.
 *
 * Tests verify:
 *   - Valid JWT grants access with correct tenantId
 *   - Expired JWT is rejected (401)
 *   - Invalid JWT signature is rejected (401)
 *   - Valid API key resolves tenant from DB
 *   - Unknown API key returns 401
 *   - Suspended tenant returns 403
 *   - Missing credentials return 401
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// ── Minimal Fastify request / reply mocks ─────────────────────────────────────

function makeRequest(headers: Record<string, string> = {}): any {
  return { headers, url: '/v1/render', routerPath: '/v1/render' };
}

function makeReply(): any {
  const reply: any = { _code: 200, _body: null };
  reply.code  = function(n: number) { reply._code = n; return reply; };
  reply.send  = function(b: any)    { reply._body = b; return reply; };
  return reply;
}

// ── DB mock ───────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-32-chars-long-enough!!';

function makeDb(rows: any[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

// ── Import under test ─────────────────────────────────────────────────────────

import { buildAuthHook } from './auth';

// ─────────────────────────────────────────────────────────────────────────────

describe('buildAuthHook — JWT authentication', () => {
  it('grants access with a valid JWT', async () => {
    const tenantRow = { tenant_id: 'tid-1', max_concurrency: 10, is_active: true };
    const db        = makeDb([tenantRow]);
    const hook      = buildAuthHook(db as any, JWT_SECRET, { warn: vi.fn() } as any);

    const token   = jwt.sign({ tenant_id: 'tid-1' }, JWT_SECRET, { expiresIn: '1h' });
    const request = makeRequest({ authorization: `Bearer ${token}` });
    const reply   = makeReply();

    await hook(request, reply);

    expect(request.tenantId).toBe('tid-1');
    expect(request.maxConcurrency).toBe(10);
    expect(reply._code).toBe(200); // not touched
  });

  it('rejects an expired JWT with 401', async () => {
    const db   = makeDb([]);
    const hook = buildAuthHook(db as any, JWT_SECRET, { warn: vi.fn() } as any);

    // Sign a token with iat and exp both in the past
    const now   = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      { tenant_id: 'tid-1', iat: now - 7200, exp: now - 3600 },
      JWT_SECRET,
    );
    const request = makeRequest({ authorization: `Bearer ${token}` });
    const reply   = makeReply();

    await hook(request, reply);

    expect(reply._code).toBe(401);
    expect(reply._body).toMatchObject({ error: 'unauthorized' });
  });

  it('rejects a JWT signed with a wrong secret', async () => {
    const db   = makeDb([]);
    const hook = buildAuthHook(db as any, JWT_SECRET, { warn: vi.fn() } as any);

    const token   = jwt.sign({ tenant_id: 'tid-1' }, 'wrong-secret');
    const request = makeRequest({ authorization: `Bearer ${token}` });
    const reply   = makeReply();

    await hook(request, reply);

    expect(reply._code).toBe(401);
  });

  it('returns 403 when tenant is suspended', async () => {
    const tenantRow = { tenant_id: 'tid-2', max_concurrency: 10, is_active: false };
    const db        = makeDb([tenantRow]);
    const hook      = buildAuthHook(db as any, JWT_SECRET, { warn: vi.fn() } as any);

    const token   = jwt.sign({ tenant_id: 'tid-2' }, JWT_SECRET, { expiresIn: '1h' });
    const request = makeRequest({ authorization: `Bearer ${token}` });
    const reply   = makeReply();

    await hook(request, reply);

    expect(reply._code).toBe(403);
    expect(reply._body).toMatchObject({ error: 'tenant_suspended' });
  });
});

describe('buildAuthHook — API key authentication', () => {
  it('grants access with a valid API key', async () => {
    const tenantRow = { tenant_id: 'tid-3', max_concurrency: 20, is_active: true };
    const db        = makeDb([tenantRow]);
    const hook      = buildAuthHook(db as any, JWT_SECRET, { warn: vi.fn() } as any);

    const request = makeRequest({ 'x-api-key': 'any-raw-key' });
    const reply   = makeReply();

    await hook(request, reply);

    expect(request.tenantId).toBe('tid-3');
    expect(reply._code).toBe(200);
  });

  it('returns 401 for an unknown API key', async () => {
    const db   = makeDb([]); // no rows returned
    const hook = buildAuthHook(db as any, JWT_SECRET, { warn: vi.fn() } as any);

    const request = makeRequest({ 'x-api-key': 'unknown-key' });
    const reply   = makeReply();

    await hook(request, reply);

    expect(reply._code).toBe(401);
  });

  it('returns 401 when no credentials provided', async () => {
    const db   = makeDb([]);
    const hook = buildAuthHook(db as any, JWT_SECRET, { warn: vi.fn() } as any);

    const request = makeRequest({});
    const reply   = makeReply();

    await hook(request, reply);

    expect(reply._code).toBe(401);
  });
});
