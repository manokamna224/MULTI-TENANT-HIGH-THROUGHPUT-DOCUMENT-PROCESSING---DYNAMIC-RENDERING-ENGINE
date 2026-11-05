/**
 * Webhook dispatcher.
 *
 * For each completed/signed job it:
 *   1. Queries the database for all active webhook endpoints registered by the tenant
 *   2. Generates an ephemeral presigned URL
 *   3. POSTs a signed JSON payload to each endpoint URL
 *   4. Signs the outbound request body with HMAC-SHA256 using the endpoint's secret
 *      — receivers can verify via X-DocEngine-Signature header
 *
 * Retry policy: 3 attempts with exponential backoff (1s, 2s, 4s).
 * Failures are logged; we do NOT block the main stream consumer on delivery.
 */
import crypto from 'crypto';
import axios, { AxiosError } from 'axios';
import { Pool } from 'pg';
import { Logger } from 'winston';
import { Presigner } from './presigner';

const MAX_ATTEMPTS = 3;

export interface WebhookPayload {
  event:        string;      // "job.completed" | "job.failed"
  job_id:       string;
  tenant_id:    string;
  document_type: string;
  storage_path?: string;
  download_url?: string;     // ephemeral presigned URL
  sha256?:      string;
  signed_at?:   string;
  error_log?:   string;
  timestamp:    string;      // ISO-8601 dispatch time
}

interface WebhookEndpoint {
  endpoint_id: string;
  url:         string;
  secret_hash: string;       // stored as hex(HMAC-SHA256 of the secret itself)
  // We re-derive the HMAC from the raw secret stored in-row.
  // Production: use Vault or AWS Secrets Manager to avoid DB exposure.
}

export class WebhookDispatcher {
  private db:        Pool;
  private presigner: Presigner;
  private log:       Logger;

  constructor(databaseUrl: string, presigner: Presigner, log: Logger) {
    this.db        = new Pool({ connectionString: databaseUrl, max: 5 });
    this.presigner = presigner;
    this.log       = log;
  }

  async dispatch(payload: WebhookPayload): Promise<void> {
    const endpoints = await this.fetchEndpoints(payload.tenant_id, payload.event);
    if (endpoints.length === 0) return;

    // Generate presigned URL once; share across all endpoints for this job
    let downloadUrl: string | undefined;
    if (payload.storage_path) {
      try {
        downloadUrl = await this.presigner.generateUrl(payload.storage_path);
      } catch (err) {
        this.log.warn('presigning failed', { jobId: payload.job_id, err });
      }
    }

    const enriched: WebhookPayload = { ...payload, download_url: downloadUrl };
    const body = JSON.stringify(enriched);

    await Promise.allSettled(
      endpoints.map((ep) => this.sendWithRetry(ep, body)),
    );
  }

  private async fetchEndpoints(
    tenantId: string,
    event: string,
  ): Promise<WebhookEndpoint[]> {
    const result = await this.db.query<WebhookEndpoint>(
      `SELECT endpoint_id, url, secret_hash
       FROM webhook_endpoints
       WHERE tenant_id = $1
         AND is_active  = TRUE
         AND $2 = ANY(events)`,
      [tenantId, event],
    );
    return result.rows;
  }

  private async sendWithRetry(
    endpoint: WebhookEndpoint,
    body: string,
  ): Promise<void> {
    // The secret_hash column stores the raw HMAC secret (in production: encrypted).
    const sig = crypto
      .createHmac('sha256', endpoint.secret_hash)
      .update(body)
      .digest('hex');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await axios.post(endpoint.url, body, {
          headers: {
            'Content-Type':           'application/json',
            'X-DocEngine-Signature':  `sha256=${sig}`,
            'X-DocEngine-Attempt':    String(attempt),
          },
          timeout: 10_000,
        });
        this.log.info('webhook delivered', { url: endpoint.url, attempt });
        return;
      } catch (err) {
        const status = (err as AxiosError).response?.status;
        this.log.warn('webhook attempt failed', {
          url: endpoint.url, attempt, status,
          error: (err as Error).message,
        });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s, 4s
        }
      }
    }
    this.log.error('webhook delivery failed after all attempts', { url: endpoint.url });
  }

  async close(): Promise<void> {
    await this.db.end();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
