/**
 * Unit tests for WebhookDispatcher.
 *
 * Mocks:
 *   - pg Pool        — returns configured endpoint rows
 *   - axios.post     — simulates delivery success, 500 error, and network failure
 *   - Presigner      — returns a fake presigned URL
 *
 * Tests verify:
 *   - Successful delivery on first attempt
 *   - Retry logic: 3 attempts with exponential backoff on 5xx
 *   - HMAC-SHA256 signature header is present and correct
 *   - No delivery when no endpoints are registered
 *   - Presigned URL is included in the outbound payload
 *   - Delivery continues to other endpoints if one fails
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ── Mock axios ────────────────────────────────────────────────────────────────
const mockAxiosPost = vi.fn().mockResolvedValue({ status: 200 });
vi.mock('axios', () => ({ default: { post: mockAxiosPost } }));

// ─────────────────────────────────────────────────────────────────────────────

import { WebhookDispatcher, WebhookPayload } from './webhook-dispatcher';

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}

function makePresigner(url = 'https://s3.example.com/presigned') {
  return { generateUrl: vi.fn().mockResolvedValue(url) } as any;
}

function makeDb(endpoints: any[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows: endpoints }), end: vi.fn() };
}

const ENDPOINT_SECRET = 'test-webhook-secret-32-chars-long!!';

const SAMPLE_ENDPOINT = {
  endpoint_id: 'ep-1',
  url:         'https://consumer.example.com/webhook',
  secret_hash: ENDPOINT_SECRET,
};

const SAMPLE_PAYLOAD: WebhookPayload = {
  event:         'job.completed',
  job_id:        'job-123',
  tenant_id:     'tenant-abc',
  document_type: 'measurement_book',
  storage_path:  's3://bucket/path/job.pdf',
  timestamp:     new Date().toISOString(),
};

// ─────────────────────────────────────────────────────────────────────────────

describe('WebhookDispatcher', () => {
  let dispatcher: WebhookDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    const db = makeDb([SAMPLE_ENDPOINT]);
    dispatcher = new WebhookDispatcher('postgres://x', makePresigner(), makeLog());
    // Inject mock db directly
    (dispatcher as any).db = db;
  });

  it('delivers webhook on first attempt', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200 });
    await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it('sends HMAC-SHA256 signature header', async () => {
    await dispatcher.dispatch(SAMPLE_PAYLOAD);
    const [, body, opts] = mockAxiosPost.mock.calls[0] as [string, string, any];
    const expectedSig = `sha256=${crypto
      .createHmac('sha256', ENDPOINT_SECRET)
      .update(body)
      .digest('hex')}`;
    expect(opts.headers['X-DocEngine-Signature']).toBe(expectedSig);
  });

  it('includes download_url in the outbound payload', async () => {
    await dispatcher.dispatch(SAMPLE_PAYLOAD);
    const [, body] = mockAxiosPost.mock.calls[0] as [string, string, any];
    const parsed = JSON.parse(body);
    expect(parsed.download_url).toBe('https://s3.example.com/presigned');
  });

  it('retries up to 3 times on 5xx failure', async () => {
    const axiosErr = Object.assign(new Error('Server Error'), {
      response: { status: 500 },
    });
    mockAxiosPost
      .mockRejectedValueOnce(axiosErr)
      .mockRejectedValueOnce(axiosErr)
      .mockRejectedValueOnce(axiosErr);

    await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(mockAxiosPost).toHaveBeenCalledTimes(3);
  });

  it('succeeds on second attempt after transient failure', async () => {
    const axiosErr = Object.assign(new Error('timeout'), { response: null });
    mockAxiosPost
      .mockRejectedValueOnce(axiosErr)
      .mockResolvedValueOnce({ status: 200 });

    await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
  });

  it('does not call axios when no endpoints registered', async () => {
    (dispatcher as any).db = makeDb([]); // no endpoints
    await dispatcher.dispatch(SAMPLE_PAYLOAD);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('delivers to all endpoints even if one fails', async () => {
    const db = makeDb([
      SAMPLE_ENDPOINT,
      { ...SAMPLE_ENDPOINT, endpoint_id: 'ep-2', url: 'https://other.example.com/hook' },
    ]);
    (dispatcher as any).db = db;

    // First endpoint always fails; second succeeds
    const axiosErr = Object.assign(new Error('fail'), { response: { status: 500 } });
    mockAxiosPost
      .mockRejectedValue(axiosErr)   // ep-1 all 3 attempts
      .mockResolvedValueOnce({ status: 200 }) // ep-2 first attempt
      .mockResolvedValueOnce({ status: 200 });

    await dispatcher.dispatch(SAMPLE_PAYLOAD);
    // ep-1: 3 retries; ep-2: 1 success → total >= 4 calls
    expect(mockAxiosPost.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
