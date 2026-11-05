import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories must NOT reference outer variables (hoisting rule).
// Use vi.fn() inside the factory and capture via vi.mocked() after import.
vi.mock('puppeteer-core', () => ({
  default: {
    launch: vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      on:    vi.fn(),
    }),
  },
}));

vi.mock('@sparticuz/chromium', () => ({
  default: {
    executablePath: vi.fn().mockResolvedValue('/fake/chromium'),
  },
}));

import puppeteer from 'puppeteer-core';
import { BrowserPool } from './browser-pool';

const mockLaunch = vi.mocked(puppeteer.launch);
const makeLog = () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any);

describe('BrowserPool', () => {
  beforeEach(() => {
    mockLaunch.mockClear();
    // Reset to fresh mock browser each call
    mockLaunch.mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      on:    vi.fn(),
    } as any);
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
    const idx = await pool.acquire();
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
    const idx2 = await pool.acquire();
    expect(idx2).toBe(idx1);
    await pool.closeAll();
  });

  it('release() recycles browser after maxJobs reached', async () => {
    const pool = new BrowserPool(1, 1, 999, makeLog());
    await pool.init();
    const idx = await pool.acquire();
    await pool.release(idx);
    // 1 initial launch + 1 recycle = 2 total
    expect(mockLaunch).toHaveBeenCalledTimes(2);
    await pool.closeAll();
  });

  it('closeAll() closes all open browsers', async () => {
    const closeFn = vi.fn().mockResolvedValue(undefined);
    mockLaunch.mockResolvedValue({ close: closeFn, on: vi.fn() } as any);
    const pool = new BrowserPool(3, 50, 250, makeLog());
    await pool.init();
    await pool.closeAll();
    expect(closeFn).toHaveBeenCalledTimes(3);
  });

  it('two concurrent acquires get different slots', async () => {
    const pool = new BrowserPool(2, 50, 250, makeLog());
    await pool.init();
    const [idx1, idx2] = await Promise.all([pool.acquire(), pool.acquire()]);
    expect(idx1).not.toBe(idx2);
    await pool.closeAll();
  });
});
