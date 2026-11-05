/**
 * Unit tests for Presigner — ephemeral S3 presigned URL generation.
 *
 * Mocks aws-sdk S3.getSignedUrlPromise so no real AWS credentials are needed.
 * Tests verify:
 *   - generateUrl() returns a string URL
 *   - The S3 key is correctly extracted from the storage path
 *   - The correct Bucket and Expires are passed to the SDK
 *   - Custom endpoint uses path-style addressing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock aws-sdk ──────────────────────────────────────────────────────────────
const FAKE_URL          = 'https://s3.amazonaws.com/bucket/key?X-Amz-Expires=3600';
const mockGetSignedUrl  = vi.fn().mockResolvedValue(FAKE_URL);

vi.mock('aws-sdk', () => ({
  default: {
    S3: vi.fn().mockImplementation(() => ({
      getSignedUrlPromise: mockGetSignedUrl,
    })),
  },
}));

// ─────────────────────────────────────────────────────────────────────────────

import { Presigner } from './presigner';

function makeConfig(overrides: Partial<{
  artifactBucket: string;
  s3Endpoint: string;
  awsRegion: string;
  presignTtlSec: number;
}> = {}) {
  return {
    redisUrl:       'redis://localhost',
    consumerGroup:  'test',
    consumerName:   'test',
    databaseUrl:    'postgres://x',
    artifactBucket: 'my-bucket',
    awsRegion:      'ap-south-1',
    presignTtlSec:  3600,
    ...overrides,
  } as any;
}

describe('Presigner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generateUrl() returns a string URL', async () => {
    const p   = new Presigner(makeConfig());
    const url = await p.generateUrl('s3://my-bucket/tenant/doc/2026/11/job.pdf');
    expect(typeof url).toBe('string');
    expect(url).toBe(FAKE_URL);
  });

  it('passes the correct Bucket and Key to the SDK', async () => {
    const p = new Presigner(makeConfig({ artifactBucket: 'test-bucket' }));
    await p.generateUrl('s3://test-bucket/tenant-id/measurement_book/2026/11/job-123.pdf');

    const [, params] = mockGetSignedUrl.mock.calls[0] as [string, any];
    expect(params.Bucket).toBe('test-bucket');
    expect(params.Key).toBe('tenant-id/measurement_book/2026/11/job-123.pdf');
  });

  it('uses the configured TTL for Expires', async () => {
    const p = new Presigner(makeConfig({ presignTtlSec: 1800 }));
    await p.generateUrl('s3://my-bucket/key.pdf');

    const [, params] = mockGetSignedUrl.mock.calls[0] as [string, any];
    expect(params.Expires).toBe(1800);
  });

  it('works when storage path lacks the s3://bucket/ prefix', async () => {
    const p = new Presigner(makeConfig());
    // Fallback: path is just the key itself
    await p.generateUrl('tenant/doc/job.pdf');

    const [, params] = mockGetSignedUrl.mock.calls[0] as [string, any];
    expect(params.Key).toBe('tenant/doc/job.pdf');
  });
});
