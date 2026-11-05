/**
 * BrowserPool — managed pool of isolated Chromium instances.
 *
 * Design:
 *   - Fixed number of slots equal to `poolSize` (== WORKER_CONCURRENCY).
 *   - Each slot owns exactly one Chromium Browser process.
 *   - `acquire()` claims an idle slot; `release()` marks it idle again.
 *   - On release, lifecycle counters are checked:
 *       jobCount  >= maxJobs  → recycle (kill + relaunch browser)
 *       process RSS > maxRssMb → recycle
 *   - Slot state machine: idle → inUse → idle (or idle → recycling → idle)
 *   - No shared state between concurrent jobs — each job owns its slot
 *     exclusively for its entire duration.
 */
import puppeteer, { Browser } from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { Logger } from 'winston';

const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
  '--no-zygote',
  '--safebrowsing-disable-auto-update',
  '--headless=new',
];

interface BrowserSlot {
  browser:   Browser;
  jobCount:  number;
  inUse:     boolean;
}

export class BrowserPool {
  private readonly slots: (BrowserSlot | null)[];
  private initialized = false;

  constructor(
    private readonly poolSize: number,
    private readonly maxJobs:  number,
    private readonly maxRssMb: number,
    private readonly log:      Logger,
  ) {
    this.slots = new Array(poolSize).fill(null);
  }

  /** Must be called once before any acquire(). Launches all browser slots. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await Promise.all(this.slots.map((_, i) => this.launchSlot(i)));
    this.initialized = true;
    this.log.info('browser pool initialised', { poolSize: this.poolSize });
  }

  /**
   * Acquire a free slot. Spins with 50 ms backoff until one is available.
   * Returns the slot index — pass it to getBrowser() and release().
   */
  async acquire(): Promise<number> {
    for (;;) {
      for (let i = 0; i < this.slots.length; i++) {
        const slot = this.slots[i];
        if (slot && !slot.inUse) {
          slot.inUse = true;
          return i;
        }
      }
      await sleep(50);
    }
  }

  /** Returns the browser for a slot that was previously acquired. */
  getBrowser(idx: number): Browser {
    const slot = this.slots[idx];
    if (!slot) throw new Error(`Slot ${idx} is not initialised`);
    return slot.browser;
  }

  /**
   * Release a slot back to the pool. Increments jobCount and triggers a
   * browser recycle if lifecycle limits are breached.
   */
  async release(idx: number): Promise<void> {
    const slot = this.slots[idx];
    if (!slot) return;

    slot.jobCount += 1;

    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    const needsRecycle = slot.jobCount >= this.maxJobs || rssMb > this.maxRssMb;

    if (needsRecycle) {
      this.log.info('recycling browser slot', {
        idx,
        jobCount: slot.jobCount,
        rssMb: rssMb.toFixed(1),
        reason: slot.jobCount >= this.maxJobs ? 'job_limit' : 'rss_limit',
      });
      try {
        await slot.browser.close();
      } catch {
        /* best-effort close; process may already be dead */
      }
      // Null out while relaunching so acquire() won't hand out a dead slot
      this.slots[idx] = null;
      await this.launchSlot(idx);
    } else {
      slot.inUse = false;
    }
  }

  /** Close all browsers and clear slots. Call on graceful shutdown. */
  async closeAll(): Promise<void> {
    await Promise.all(
      this.slots.map(async (slot, i) => {
        if (!slot) return;
        this.slots[i] = null;
        try { await slot.browser.close(); } catch { /* best effort */ }
      }),
    );
    this.log.info('browser pool closed');
  }

  private async launchSlot(idx: number): Promise<void> {
    const execPath = await chromium.executablePath();
    const browser = await puppeteer.launch({
      executablePath: execPath,
      args: CHROMIUM_ARGS,
      headless: 'new' as any, // 'new' headless mode (Puppeteer v22+)
    });

    // Listen for unexpected disconnects and recycle the slot automatically
    browser.on('disconnected', () => {
      if (this.slots[idx]) {
        this.log.warn('browser disconnected unexpectedly — scheduling recycle', { idx });
        this.slots[idx] = null;
        this.launchSlot(idx).catch((e) =>
          this.log.error('failed to relaunch slot after disconnect', { idx, err: e }),
        );
      }
    });

    this.slots[idx] = { browser, jobCount: 0, inUse: false };
    this.log.debug('browser slot ready', { idx });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
