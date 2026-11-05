import { describe, it, expect, vi, beforeEach } from 'vitest';

// All factories use inline vi.fn() — no outer variable refs (vitest hoisting rule)
vi.mock('ioredis', () => ({
  default: vi.fn(),
}));

vi.mock('./webhook-dispatcher', () => ({
  WebhookDispatcher: vi.fn(),
}));

vi.mock('./presigner', () => ({
  Presigner: vi.fn().mockImplementation(() => ({
    generateUrl: vi.fn().mockResolvedValue('https://fake.url'),
  })),
}));

import Redis from 'ioredis';
import { WebhookDispatcher } from './webhook-dispatcher';
import { NotificationWorker } from './notification-worker';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

function makeCfg() {
  return {
    redisUrl: 'redis://localhost', consumerGroup: 'grp',
    consumerName: 'c1', databaseUrl: 'pg://x',
    artifactBucket: 'b', awsRegion: 'us-east-1', presignTtlSec: 3600,
  } as any;
}

// ioredis xreadgroup response format:
// [ [streamName, [ [msgId, [field, value, ...]], ... ] ] ]
function makeMsg(stream: string, msgId: string, payload: object): any {
  return [[stream, [[msgId, ['result', JSON.stringify(payload)]]]]];
}

// Create fresh mock instances before each test
let mockRedis: any;
let mockDispatcher: any;

beforeEach(() => {
  vi.clearAllMocks();

  mockRedis = {
    connect:    vi.fn().mockResolvedValue(undefined),
    xgroup:     vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xack:       vi.fn().mockResolvedValue(1),
    quit:       vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(Redis).mockImplementation(() => mockRedis as any);

  mockDispatcher = {
    dispatch: vi.fn().mockResolvedValue(undefined),
    close:    vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(WebhookDispatcher).mockImplementation(() => mockDispatcher as any);
});

describe('NotificationWorker message handling', () => {

  it('dispatches job.completed for a completed result', async () => {
    const payload = {
      job_id: 'j1', tenant_id: 't1', document_type: 'mb',
      storage_path: 's3://b/k.pdf', status: 'completed',
    };
    mockRedis.xreadgroup
      .mockResolvedValueOnce(makeMsg('signed:results', 'mid-1', payload))
      .mockResolvedValue(null);

    const worker = new NotificationWorker(makeCfg(), log);
    worker.shutdown();
    await worker.run();

    expect(mockDispatcher.dispatch).toHaveBeenCalledOnce();
    expect(mockDispatcher.dispatch.mock.calls[0][0].event).toBe('job.completed');
    expect(mockRedis.xack).toHaveBeenCalledWith('signed:results', 'grp', 'mid-1');
  });

  it('dispatches job.failed for a failed result', async () => {
    const payload = { job_id: 'j2', tenant_id: 't', document_type: 'mb', status: 'failed' };
    mockRedis.xreadgroup
      .mockResolvedValueOnce(makeMsg('signed:results', 'mid-2', payload))
      .mockResolvedValue(null);

    const worker = new NotificationWorker(makeCfg(), log);
    worker.shutdown();
    await worker.run();

    expect(mockDispatcher.dispatch.mock.calls[0]?.[0]?.event).toBe('job.failed');
  });

  it('skips non-completed messages on render:results', async () => {
    const payload = { job_id: 'j3', tenant_id: 't', document_type: 'mb', status: 'processing' };
    mockRedis.xreadgroup
      .mockResolvedValueOnce(makeMsg('render:results', 'mid-3', payload))
      .mockResolvedValue(null);

    const worker = new NotificationWorker(makeCfg(), log);
    worker.shutdown();
    await worker.run();

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(mockRedis.xack).toHaveBeenCalledWith('render:results', 'grp', 'mid-3');
  });

  it('ACKs and discards message with missing result field', async () => {
    mockRedis.xreadgroup
      .mockResolvedValueOnce([['signed:results', [['mid-4', ['other_field', 'val']]]]])
      .mockResolvedValue(null);

    const worker = new NotificationWorker(makeCfg(), log);
    worker.shutdown();
    await worker.run();

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(mockRedis.xack).toHaveBeenCalledWith('signed:results', 'grp', 'mid-4');
  });

  it('ACKs and discards message with malformed JSON', async () => {
    mockRedis.xreadgroup
      .mockResolvedValueOnce([['signed:results', [['mid-5', ['result', '{bad']]]]])
      .mockResolvedValue(null);

    const worker = new NotificationWorker(makeCfg(), log);
    worker.shutdown();
    await worker.run();

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(mockRedis.xack).toHaveBeenCalledWith('signed:results', 'grp', 'mid-5');
    expect(log.error).toHaveBeenCalled();
  });
});
