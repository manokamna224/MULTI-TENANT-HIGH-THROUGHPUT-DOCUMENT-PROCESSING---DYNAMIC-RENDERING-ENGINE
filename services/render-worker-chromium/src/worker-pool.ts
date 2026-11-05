/**
 * Worker pool: drains the render:jobs Redis Stream (chromium-workers group).
 *
 * Per-job lifecycle:
 *   1. XREADGROUP   — claim next message
 *   2. Parse job JSON
 *   3. Acquire BrowserPool slot
 *   4. ChromiumRenderer.render() → PDF bytes
 *   5. SHA-256 checksum of bytes
 *   6. S3Uploader.upload() → storage path
 *   7. JobDb.markCompleted() — update Postgres
 *   8. XADD render:results — notify downstream
 *   9. XACK — remove from PEL
 *
 * On error: XACK is NOT called — message stays in PEL for the DlqReaper.
 */
import crypto from 'crypto';
import Redis from 'ioredis';
import pLimit from 'p-limit';
import { Logger } from 'winston';
import { Config } from './config';
import { BrowserPool } from './browser-pool';
import { ChromiumRenderer } from './renderer';
import { S3Uploader } from './storage';
import { DlqReaper } from './reaper';
import { JobDb } from './db';

const STREAM_KEY    = 'render:jobs';
const RESULT_STREAM = 'render:results';
const BLOCK_MS      = 2000;

export class WorkerPool {
  private redis:    Redis;
  private pool:     BrowserPool;
  private renderer: ChromiumRenderer;
  private uploader: S3Uploader;
  private reaper:   DlqReaper;
  private db:       JobDb;
  private running = true;
  private readonly limit: ReturnType<typeof pLimit>;

  constructor(private cfg: Config, private log: Logger) {
    this.redis    = new Redis(cfg.redisUrl, { lazyConnect: true });
    this.pool     = new BrowserPool(cfg.concurrency, cfg.maxJobsPerWorker, cfg.maxRssMb, log);
    this.renderer = new ChromiumRenderer(cfg.templateDir, log);
    this.uploader = new S3Uploader(cfg.artifactBucket, cfg.s3Endpoint, log);
    this.limit    = pLimit(cfg.concurrency);
    this.reaper   = new DlqReaper(
      this.redis,
      cfg.consumerGroup,
      `reaper-${cfg.consumerName}`,
      log,
    );
    this.db = new JobDb(log);
  }

  async run(): Promise<void> {
    await this.redis.connect();
    await this.pool.init();

    try {
      await this.redis.xgroup('CREATE', STREAM_KEY, this.cfg.consumerGroup, '$', 'MKSTREAM');
    } catch (e: any) {
      if (!e.message?.includes('BUSYGROUP')) throw e;
    }

    this.log.info('chromium worker pool running', { consumerGroup: this.cfg.consumerGroup });
    this.reaper.start();

    while (this.running) {
      const entries = await this.redis.xreadgroup(
        'GROUP', this.cfg.consumerGroup, this.cfg.consumerName,
        'COUNT', String(this.cfg.concurrency),
        'BLOCK', String(BLOCK_MS),
        'STREAMS', STREAM_KEY, '>',
      ) as any[] | null;

      if (!entries) continue;

      for (const [, messages] of entries) {
        for (const [msgId, fields] of messages) {
          // Fire-and-forget inside pLimit — errors are caught inside handleJob
          void this.limit(() => this.handleJob(msgId, fields as string[]));
        }
      }
    }

    await this.pool.closeAll();
    await this.db.close();
    await this.redis.quit();
  }

  shutdown(): void {
    this.running = false;
    this.reaper.stop();
  }

  private async handleJob(msgId: string, fields: string[]): Promise<void> {
    const fieldMap: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) {
      fieldMap[fields[i]] = fields[i + 1];
    }

    const rawPayload = fieldMap['payload'];
    if (!rawPayload) {
      this.log.warn('empty payload — ACKing to discard', { msgId });
      await this.redis.xack(STREAM_KEY, this.cfg.consumerGroup, msgId);
      return;
    }

    let job: any;
    try {
      job = JSON.parse(rawPayload);
    } catch {
      this.log.error('malformed JSON — ACKing to discard', { msgId });
      await this.redis.xack(STREAM_KEY, this.cfg.consumerGroup, msgId);
      return;
    }

    const start    = Date.now();
    const slotIdx  = await this.pool.acquire();

    try {
      const browser = this.pool.getBrowser(slotIdx);

      const { pdfBytes, elapsedMs } = await this.renderer.render(
        browser,
        job.document_type,
        job.payload,
      );

      // Checksum before upload
      const checksum = crypto.createHash('sha256').update(pdfBytes).digest('hex');

      const storagePath = await this.uploader.upload(
        job.tenant_id,
        job.document_type,
        job.job_id,
        pdfBytes,
      );

      const execMs = Date.now() - start;

      // Update Postgres
      await this.db.markCompleted(job.job_id, storagePath, checksum, execMs);

      // Publish result for signing + notification workers
      await this.redis.xadd(RESULT_STREAM, '*',
        'result', JSON.stringify({
          job_id:            job.job_id,
          tenant_id:         job.tenant_id,
          document_type:     job.document_type,
          status:            'completed',
          storage_path:      storagePath,
          computed_checksum: checksum,
          execution_time_ms: execMs,
        }),
      );

      await this.redis.xack(STREAM_KEY, this.cfg.consumerGroup, msgId);
      this.log.info('job completed', { jobId: job.job_id, elapsedMs });

    } catch (err: any) {
      this.log.error('job failed', { jobId: job.job_id, error: err.message });
      // Update DB as failed (best effort)
      if (job?.job_id) {
        await this.db.markFailed(job.job_id, err.message ?? 'unknown error');
      }
      // Do NOT XACK — reaper will retry
    } finally {
      await this.pool.release(slotIdx);
    }
  }
}
