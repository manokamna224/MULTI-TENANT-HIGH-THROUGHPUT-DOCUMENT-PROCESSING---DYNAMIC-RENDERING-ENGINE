/**
 * NotificationWorker unit tests.
 *
 * Uses constructor injection instead of vi.mock to avoid ESM/CJS hoisting issues.
 * Both the Redis client and WebhookDispatcher are passed in as mocks directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationWorker } from './notification-worker';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

function makeCfg() {
  return {
    redisUrl: 'redis://localhost', consumerGroup: 'grp', consumerName: 'c1',
    databaseUrl: 'pg://x', artifactBucket: 'b', awsRegion: 'us-east-1', presignTtlSec: 3600,
  } as any;
}

// Build a fake Redis client
function makeFakeRedis(xreadgroupResponses: any[]) {
  let callIdx = 0;
  return {
    connect:    vi.fn().mockResolvedValue(undefined),
    xgroup:     vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockImplementation(() => {
      const resp = xreadgroupResponses[callIdx];
      callIdx = Math.min(callIdx + 1, xreadgroupResponses.length - 1);
      return Promise.resolve(resp ?? null);
    }),
    xack: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue(undefined),
  } as any;
}

// Build a fake WebhookDispatcher
function makeFakeDispatcher() {
  return {
    dispatch: vi.fn().mockResolvedValue(undefined),
    close:    vi.fn().mockResolvedValue(undefined),
  } as any;
}

// ioredis xreadgroup format: [[stream, [[msgId, [f, v, ...]], ...]]]
function makeMsg(stream: string, msgId: string, payload: object): any {
  return [[stream, [[msgId, ['result', JSON.stringify(payload)]]]]];
}

describe('NotificationWorker message handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches job.completed for a completed result', async () => {
    const payload = { job_id: 'j1', tenant_id: 't1', document_type: 'mb',
                      storage_path: 's3://b/k.pdf', status: 'completed' };
    const redis      = makeFakeRedis([makeMsg('signed:results', 'mid-1', payload), null]);
    const dispatcher = makeFakeDispatcher();

    const worker = new NotificationWorker(makeCfg(), log, dispatcher, redis);
    worker.shutdown();
    await worker.run();

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(dispatcher.dispatch.mock.calls[0][0].event).toBe('job.completed');
    expect(redis.xack).toHaveBeenCalledWith('signed:results', 'grp', 'mid-1');
  });

  it('dispatches job.failed for a failed result', async () => {
    const payload = { job_id: 'j2', tenant_id: 't', document_type: 'mb', status: 'failed' };
    const redis      = makeFakeRedis([makeMsg('signed:results', 'mid-2', payload), null]);
    const dispatcher = makeFakeDispatcher();

    const worker = new NotificationWorker(makeCfg(), log, dispatcher, redis);
    worker.shutdown();
    await worker.run();

    expect(dispatcher.dispatch.mock.calls[0]?.[0]?.event).toBe('job.failed');
  });

  it('skips non-completed messages from render:results', async () => {
    const payload = { job_id: 'j3', tenant_id: 't', document_type: 'mb', status: 'processing' };
    const redis      = makeFakeRedis([makeMsg('render:results', 'mid-3', payload), null]);
    const dispatcher = makeFakeDispatcher();

    const worker = new NotificationWorker(makeCfg(), log, dispatcher, redis);
    worker.shutdown();
    await worker.run();

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(redis.xack).toHaveBeenCalledWith('render:results', 'grp', 'mid-3');
  });

  it('ACKs and discards message with missing result field', async () => {
    const redis      = makeFakeRedis([[['signed:results', [['mid-4', ['other', 'val']]]]], null]);
    const dispatcher = makeFakeDispatcher();

    const worker = new NotificationWorker(makeCfg(), log, dispatcher, redis);
    worker.shutdown();
    await worker.run();

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(redis.xack).toHaveBeenCalledWith('signed:results', 'grp', 'mid-4');
  });

  it('ACKs and discards message with malformed JSON', async () => {
    const redis      = makeFakeRedis([[['signed:results', [['mid-5', ['result', '{bad json']]]]], null]);
    const dispatcher = makeFakeDispatcher();

    const worker = new NotificationWorker(makeCfg(), log, dispatcher, redis);
    worker.shutdown();
    await worker.run();

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(redis.xack).toHaveBeenCalledWith('signed:results', 'grp', 'mid-5');
    expect(log.error).toHaveBeenCalled();
  });
});
