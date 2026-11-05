/**
 * Unit tests for BrowserPool lifecycle management.
 *
 * These tests mock puppeteer-core and @sparticuz/chromium so no real
 * Chromium binary is required in CI. They verify:
 *
 *   - init() launches poolSize browser slots
 *   - acquire() returns a free slot index
 *   - getBrowser() returns the browser for that slot
 *   - release() marks the slot idle (reusable by next acquire)
 *   - release() recycles when jobCount >= maxJobs
 *   - closeAll() closes every open browser
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock puppeteer-core and @sparticuz/chromium ───────────────────────────────

const mockClose  = vi.fn().mockResolvedValue(undefined);
const mockLaunch = vi.fn().mockResolvedValue({
  close: mockClose,
  on:    vi.fn(),      // for the 'disconnected' event listener
});

vi.mock('puppeteer-core', () => ({ default: { launch: mockLaunch } }));
vi.mock('@sparticuz/chromium', () => ({
  default: { executablePath: vi.fn().mockResolvedValue('/fake/chromium') },
}));

import { BrowserPool } from './browser-pool';

function makeLog() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('BrowserPool', () => {
  beforeEach(() => {
    mockLaunch.mockClear();
    mockClose.mockClear();
  });

  it('init() launches exactly poolSize browsers', async () => {
    const pool = new BrowserPool(3, 50, 250, makeLog());
    await pool.init();
    expect(mockLaunch).toHaveBeenCalledTimes(3);
    await pool.closeAll();
  });

  it('acquire() returns a valid slot index', async () => {
    const pool = new BrowserPool(2, 50, 250, makeLog());
    await pool.init();
    const idx = await pool.acquire();
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(2);
    await pool.closeAll();
  });

  it('getBrowser() returns the browser for an acquired slot', async () => {
    const pool = new BrowserPool(1, 50, 250, makeLog());
    await pool.init();
    const idx     = await pool.acquire();
    const browser = pool.getBrowser(idx);
    expect(browser).toBeDefined();
    expect(browser).toHaveProperty('close');
    await pool.closeAll();
  });

  it('release() makes the slot reusable', async () => {
    const pool = new BrowserPool(1, 50, 250, makeLog());
    await pool.init();

    const idx1 = await pool.acquire();
    await pool.release(idx1);

    // Should be able to acquire the same slot again immediately
    const idx2 = await pool.acquire();
    expect(idx2).toBe(idx1);
    await pool.closeAll();
  });

  it('release() recycles browser after maxJobs reached', async () => {
    const pool = new BrowserPool(1, 1 /* maxJobs = 1 */, 999, makeLog());
    await pool.init();

    const idx = await pool.acquire();
    await pool.release(idx); // jobCount becomes 1 == maxJobs → recycle

    // One initial launch + one recycle launch
    expect(mockLaunch).toHaveBeenCalledTimes(2);
    expect(mockClose).toHaveBeenCalledTimes(1);
    await pool.closeAll();
  });

  it('closeAll() closes all open browsers', async () => {
    const pool = new BrowserPool(3, 50, 250, makeLog());
    await pool.init();
    await pool.closeAll();
    expect(mockClose).toHaveBeenCalledTimes(3);
  });

  it('two concurrent acquires get different slots', async () => {
    const pool = new BrowserPool(2, 50, 250, makeLog());
    await pool.init();

    const [idx1, idx2] = await Promise.all([pool.acquire(), pool.acquire()]);
    expect(idx1).not.toBe(idx2);
    await pool.closeAll();
  });
});
