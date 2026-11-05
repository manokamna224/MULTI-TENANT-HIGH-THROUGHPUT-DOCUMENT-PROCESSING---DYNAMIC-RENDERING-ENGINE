/**
 * NotificationWorker consumes the `signed:results` Redis Stream and
 * fans out webhook notifications for each completed job.
 *
 * It also handles the `render:results` stream for jobs that skip signing
 * (e.g. non-financial document types that don't require a signature).
 */
import Redis from 'ioredis';
import { Logger } from 'winston';
import { Config } from './config';
import { Presigner } from './presigner';
import { WebhookDispatcher, WebhookPayload } from './webhook-dispatcher';

const STREAMS = ['signed:results', 'render:results'] as const;
const BLOCK_MS = 2000;

interface StreamResult {
  job_id:        string;
  tenant_id:     string;
  document_type: string;
  storage_path?: string;
  sha256?:       string;
  signed_at?:    string;
  status?:       string;
  error_log?:    string;
}

export class NotificationWorker {
  private redis:      Redis;
  private presigner:  Presigner;
  private dispatcher: WebhookDispatcher;
  private running = true;

  constructor(private cfg: Config, private log: Logger) {
    this.redis      = new Redis(cfg.redisUrl, { lazyConnect: true });
    this.presigner  = new Presigner(cfg);
    this.dispatcher = new WebhookDispatcher(cfg.databaseUrl, this.presigner, log);
  }

  async run(): Promise<void> {
    await this.redis.connect();

    // Ensure consumer groups exist on both streams
    for (const stream of STREAMS) {
      try {
        await this.redis.xgroup('CREATE', stream, this.cfg.consumerGroup, '$', 'MKSTREAM');
      } catch (e: any) {
        if (!e.message?.includes('BUSYGROUP')) throw e;
      }
    }

    while (this.running) {
      const entries = await this.redis.xreadgroup(
        'GROUP', this.cfg.consumerGroup, this.cfg.consumerName,
        'COUNT', '10',
        'BLOCK', String(BLOCK_MS),
        'STREAMS', ...STREAMS, ...STREAMS.map(() => '>'),
      ) as any[] | null;

      if (!entries) continue;

      for (const [streamName, messages] of entries) {
        for (const [msgId, fields] of messages) {
          await this.handleMessage(streamName, msgId, fields);
        }
      }
    }

    await this.dispatcher.close();
    await this.redis.quit();
  }

  shutdown(): void { this.running = false; }

  private async handleMessage(
    stream: string,
    msgId: string,
    fields: string[],
  ): Promise<void> {
    const fieldMap = toMap(fields);
    const raw      = fieldMap['result'];
    if (!raw) {
      await this.ack(stream, msgId);
      return;
    }

    let result: StreamResult;
    try {
      result = JSON.parse(raw);
    } catch {
      this.log.error('malformed stream message', { stream, msgId });
      await this.ack(stream, msgId);
      return;
    }

    // Skip non-completed results on render:results — signing worker handles them
    if (stream === 'render:results' && result.status !== 'completed') {
      await this.ack(stream, msgId);
      return;
    }

    const event = result.status === 'failed' ? 'job.failed' : 'job.completed';

    const payload: WebhookPayload = {
      event,
      job_id:        result.job_id,
      tenant_id:     result.tenant_id,
      document_type: result.document_type,
      storage_path:  result.storage_path,
      sha256:        result.sha256,
      signed_at:     result.signed_at,
      error_log:     result.error_log,
      timestamp:     new Date().toISOString(),
    };

    try {
      await this.dispatcher.dispatch(payload);
    } catch (err) {
      this.log.error('dispatch error', { jobId: result.job_id, err });
    }

    await this.ack(stream, msgId);
    this.log.info('notification dispatched', { jobId: result.job_id, event });
  }

  private async ack(stream: string, msgId: string): Promise<void> {
    await this.redis.xack(stream, this.cfg.consumerGroup, msgId);
  }
}

function toMap(fields: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    map[fields[i]] = fields[i + 1];
  }
  return map;
}
