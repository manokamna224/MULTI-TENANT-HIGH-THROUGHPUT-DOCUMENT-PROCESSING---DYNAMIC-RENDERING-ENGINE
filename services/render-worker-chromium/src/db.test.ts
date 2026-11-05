/**
 * Unit tests for JobDb — Postgres job status callbacks.
 *
 * Mocks pg.Pool so no real database is required.
 * Tests verify:
 *   - markCompleted() runs the correct UPDATE SQL with correct params
 *   - markFailed() runs the correct UPDATE and increments retry_count
 *   - Errors from pg are swallowed (non-fatal, just logged)
 *   - When DATABASE_URL is absent, methods are no-ops
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock pg ───────────────────────────────────────────────────────────────────
const mockQuery = vi.fn().mockResolvedValue({ rowCount: 1 });
const mockEnd   = vi.fn().mockResolvedValue(undefined);

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ query: mockQuery, end: mockEnd })),
}));

// ─────────────────────────────────────────────────────────────────────────────

import { JobDb } from './db';

const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;

describe('JobDb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost/test';
  });

  afterEach(() => {
    delete process.env['DATABASE_URL'];
  });

  it('markCompleted() calls UPDATE with correct parameters', async () => {
    const db = new JobDb(log);
    await db.markCompleted('job-1', 's3://bucket/key.pdf', 'abc123', 142);

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0] as [string, any[]];
    expect(sql).toContain("status            = 'completed'");
    expect(params).toEqual(['job-1', 's3://bucket/key.pdf', 'abc123', 142]);
  });

  it('markFailed() calls UPDATE and increments retry_count', async () => {
    const db = new JobDb(log);
    await db.markFailed('job-2', 'timeout error');

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0] as [string, any[]];
    expect(sql).toContain("status       = 'failed'");
    expect(sql).toContain('retry_count  = retry_count + 1');
    expect(params).toEqual(['job-2', 'timeout error']);
  });

  it('swallows pg errors on markCompleted and logs a warning', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    const db = new JobDb(log);

    // Should NOT throw
    await expect(db.markCompleted('job-3', 'path', 'hash', 100)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'DB markCompleted failed',
      expect.objectContaining({ jobId: 'job-3' }),
    );
  });

  it('swallows pg errors on markFailed and logs a warning', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const db = new JobDb(log);

    await expect(db.markFailed('job-4', 'render error')).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'DB markFailed failed',
      expect.objectContaining({ jobId: 'job-4' }),
    );
  });

  it('is a no-op when DATABASE_URL is absent', async () => {
    delete process.env['DATABASE_URL'];
    const db = new JobDb(log);

    await db.markCompleted('job-5', 'path', 'hash', 50);
    await db.markFailed('job-5', 'err');

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('close() calls pool.end()', async () => {
    const db = new JobDb(log);
    await db.close();
    expect(mockEnd).toHaveBeenCalledOnce();
  });
});
