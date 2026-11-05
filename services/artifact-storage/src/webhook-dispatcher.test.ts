import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// Hoisting-safe: factory uses inline vi.fn()
vi.mock('axios', () => ({ default: { post: vi.fn().mockResolvedValue({ status: 200 }) } }));

import axios from 'axios';
const mockAxiosPost = vi.mocked(axios.post);

import { WebhookDispatcher, WebhookPayload } from './webhook-dispatcher';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
const fakeUrl = 'https://s3.example.com/presigned';
const makePresigner = () => ({ generateUrl: vi.fn().mockResolvedValue(fakeUrl) } as any);
const makeDb = (rows: any[] = []) => ({ query: vi.fn().mockResolvedValue({ rows }), end: vi.fn() });

const SECRET = 'test-webhook-secret-32-chars!!';
const ENDPOINT = { endpoint_id: 'ep-1', url: 'https://consumer.example.com/hook', secret_hash: SECRET };

const PAYLOAD: WebhookPayload = {
  event: 'job.completed', job_id: 'job-1', tenant_id: 'tenant-1',
  document_type: 'measurement_book', storage_path: 's3://b/k.pdf',
  timestamp: new Date().toISOString(),
};

describe('WebhookDispatcher', () => {
  let dispatcher: WebhookDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    const db = makeDb([ENDPOINT]);
    dispatcher = new WebhookDispatcher('postgres://x', makePresigner(), log);
    (dispatcher as any).db = db;
  });

  it('delivers on first attempt', async () => {
    await dispatcher.dispatch(PAYLOAD);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it('sends correct HMAC-SHA256 signature header', async () => {
    await dispatcher.dispatch(PAYLOAD);
    const [, body, opts] = mockAxiosPost.mock.calls[0] as [string, string, any];
    const expected = `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
    expect(opts.headers['X-DocEngine-Signature']).toBe(expected);
  });

  it('includes download_url in the outbound payload', async () => {
    await dispatcher.dispatch(PAYLOAD);
    const [, body] = mockAxiosPost.mock.calls[0] as [string, string, any];
    expect(JSON.parse(body).download_url).toBe(fakeUrl);
  });

  it('retries up to 3 times on failure', async () => {
    const err = Object.assign(new Error('500'), { response: { status: 500 } });
    mockAxiosPost.mockRejectedValue(err);
    await dispatcher.dispatch(PAYLOAD);
    expect(mockAxiosPost).toHaveBeenCalledTimes(3);
  });

  it('succeeds on second attempt', async () => {
    const err = Object.assign(new Error('fail'), { response: null });
    mockAxiosPost.mockRejectedValueOnce(err).mockResolvedValueOnce({ status: 200 });
    await dispatcher.dispatch(PAYLOAD);
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
  });

  it('no call when no endpoints registered', async () => {
    (dispatcher as any).db = makeDb([]);
    await dispatcher.dispatch(PAYLOAD);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});
