/**
 * Dead-letter reaper for the Chromium render worker.
 *
 * Runs on a fixed interval alongside the main WorkerPool.
 * Uses XAUTOCLAIM to reclaim messages idle in the PEL longer than
 * CLAIM_IDLE_MS, retrying up to MAX_RETRIES times before routing
 * to the `render:dlq` dead-letter stream and ACKing the original.
 *
 * Design matches the Typst worker reaper so ops has a single mental model.
 */
import Redis from 'ioredis';
import { Logger } from 'winston';

const STREAM_KEY    = 'render:jobs';
const DLQ_STREAM    = 'render:dlq';
const CLAIM_IDLE_MS = 60_000;
const MAX_RETRIES   = 3;
const REAP_INTERVAL = 30_000; // ms

export class DlqReaper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis:     Redis,
    private readonly group:     string,
    private readonly consumer:  string,
    private readonly log:       Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.reap().catch((err) =>
        this.log.error('reaper cycle error', { err }),
      );
    }, REAP_INTERVAL);

    // unref so the timer doesn't keep the process alive on its own
    this.timer.unref();
    this.log.info('dead-letter reaper started', { group: this.group });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async reap(): Promise<void> {
    let cursor = '0-0';

    do {
      // XAUTOCLAIM returns [next-cursor, [[id, [f1,v1,...]], ...], [deleted-ids]]
      const result = await this.redis.call(
        'XAUTOCLAIM',
        STREAM_KEY, this.group, this.consumer,
        String(CLAIM_IDLE_MS), cursor,
        'COUNT', '10',
      ) as [string, [string, string[]][], string[]];

      const [nextCursor, entries] = result;

      for (const [msgId, rawFields] of entries) {
        await this.handleClaimed(msgId, rawFields);
      }

      cursor = nextCursor;
    } while (cursor !== '0-0');
  }

  private async handleClaimed(msgId: string, rawFields: string[]): Promise<void> {
    // Get delivery count: XPENDING stream group - + 1 id
    let deliveryCount = MAX_RETRIES + 1; // default to DLQ on parse failure
    try {
      const pending = await this.redis.xpending(
        STREAM_KEY, this.group, '-', '+', 1, this.consumer,
      ) as any[];
      if (pending.length > 0) {
        deliveryCount = pending[0][3] as number; // [id, consumer, idle, count]
      }
    } catch (e) {
      this.log.warn('xpending failed', { msgId, err: e });
    }

    if (deliveryCount > MAX_RETRIES) {
      // Build field map for DLQ entry
      const dlqFields: string[] = [
        'original_id', msgId,
        'delivery_count', String(deliveryCount),
        ...rawFields,
      ];

      await this.redis.call('XADD', DLQ_STREAM, '*', ...dlqFields);
      await this.redis.xack(STREAM_KEY, this.group, msgId);

      this.log.warn('message routed to DLQ', { msgId, deliveryCount });
    } else {
      // Message is now in our PEL — WorkerPool picks it up on next XREADGROUP
      this.log.info('claimed for retry', { msgId, deliveryCount });
    }
  }
}
