/**
 * Unit tests for NotificationWorker stream consumer.
 *
 * Mocks:
 *   - ioredis Redis       — simulates XREADGROUP responses
 *   - WebhookDispatcher   — verifies dispatch() is called with correct payload
 *   - Presigner           — returns a fake URL
 *
 * Tests verify:
 *   - job.completed event is dispatched for completed results
 *   - job.failed event is dispatched for failed results
 *   - Non-completed render:results messages are skipped (signing handles them)
 *   - Malformed JSON in stream is ACKed and discarded (not retried)
 *   - Missing 'result' field is ACKed and discarded
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockXack       = vi.fn().mockResolvedValue(1);
const mockXgroup     = vi.fn().mockResolvedValue('OK');
const mockXreadgroup = vi.fn().mockResolvedValue(null); // null = no messages
const mockConnect    = vi.fn().mockResolvedValue(undefined);
const mockQuit       = vi.fn().mockResolvedValue(undefined);

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({
    connect:     mockConnect,
    xgroup:      mockXgroup,
    xreadgroup:  mockXreadgroup,
    xack:        mockXack,
    quit:        mockQuit,
  })),
}));

const mockDispatch = vi.fn().mockResolvedValue(undefined);
const mockClose    = vi.fn().mockResolvedValue(undefined);

vi.mock('./webhook-dispatcher', () => ({
  WebhookDispatcher: vi.fn().mockImplementation(() => ({
    dispatch: mockDispatch,
    close:    mockClose,
  })),
}));

vi.mock('./presigner', () => ({
  Presigner: vi.fn().mockImplementation(() => ({
    generateUrl: vi.fn().mockResolvedValue('https://s3.example.com/fake'),
  })),
}));

// ─────────────────────────────────────────────────────────────────────────────

import { NotificationWorker } from './notification-worker';

function makeCfg() {
  return {
    redisUrl:       'redis://localhost',
    consumerGroup:  'test-group',
    consumerName:   'test-worker',
    databaseUrl:    'postgres://x',
    artifactBucket: 'bucket',
    awsRegion:      'us-east-1',
    presignTtlSec:  3600,
  } as any;
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

function buildStreamEntry(result: object): [string, string[]] {
  return ['stream-id-1', ['result', JSON.stringify(result)]];
}

describe('NotificationWorker message handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches job.completed for a signed result', async () => {
    const worker  = new NotificationWorker(makeCfg(), log);
    const payload = {
      job_id:        'job-1',
      tenant_id:     'tenant-1',
      document_type: 'measurement_book',
      storage_path:  's3://bucket/key.pdf',
      sha256:        'abc123',
      signed_at:     '2026-11-04T12:00:00Z',
      status:        'completed',
    };

    // Simulate one XREADGROUP response from signed:results, then stop
    mockXreadgroup
      .mockResolvedValueOnce([['signed:results', [buildStreamEntry(payload)]]])
      .mockResolvedValueOnce(null);
    worker.shutdown();

    await worker.run();

    expect(mockDispatch).toHaveBeenCalledOnce();
    const dispatchArg = mockDispatch.mock.calls[0][0];
    expect(dispatchArg.event).toBe('job.completed');
    expect(dispatchArg.job_id).toBe('job-1');
    expect(mockXack).toHaveBeenCalledWith('signed:results', 'test-group', 'stream-id-1');
  });

  it('dispatches job.failed for a failed result', async () => {
    const worker = new NotificationWorker(makeCfg(), log);
    const payload = {
      job_id: 'job-2', tenant_id: 't', document_type: 'mt',
      status: 'failed', error_log: 'render timeout',
    };

    mockXreadgroup
      .mockResolvedValueOnce([['signed:results', [buildStreamEntry(payload)]]])
      .mockResolvedValueOnce(null);
    worker.shutdown();

    await worker.run();

    const dispatchArg = mockDispatch.mock.calls[0]?.[0];
    expect(dispatchArg?.event).toBe('job.failed');
  });

  it('skips non-completed messages on render:results', async () => {
    const worker = new NotificationWorker(makeCfg(), log);
    const payload = { job_id: 'job-3', tenant_id: 't', document_type: 'mt', status: 'failed' };

    mockXreadgroup
      .mockResolvedValueOnce([['render:results', [buildStreamEntry(payload)]]])
      .mockResolvedValueOnce(null);
    worker.shutdown();

    await worker.run();

    // ACKed but not dispatched — signing worker handles failures from render:results
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockXack).toHaveBeenCalledWith('render:results', 'test-group', 'stream-id-1');
  });

  it('ACKs and discards a message with missing result field', async () => {
    const worker = new NotificationWorker(makeCfg(), log);

    mockXreadgroup
      .mockResolvedValueOnce([['signed:results', [['mid-1', ['other_field', 'value']]]]])
      .mockResolvedValueOnce(null);
    worker.shutdown();

    await worker.run();

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockXack).toHaveBeenCalledWith('signed:results', 'test-group', 'mid-1');
  });

  it('ACKs and discards a message with malformed JSON', async () => {
    const worker = new NotificationWorker(makeCfg(), log);

    mockXreadgroup
      .mockResolvedValueOnce([['signed:results', [['mid-2', ['result', '{not json']]]]])
      .mockResolvedValueOnce(null);
    worker.shutdown();

    await worker.run();

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockXack).toHaveBeenCalledWith('signed:results', 'test-group', 'mid-2');
    expect(log.error).toHaveBeenCalled();
  });
});
