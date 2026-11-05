/**
 * Minimal PostgreSQL client for the Chromium render worker.
 *
 * Updates render_jobs.status after each job completes or fails,
 * keeping the ingestion-engine's GET /v1/jobs/:id endpoint accurate.
 *
 * The pool is sized at 2 connections — sufficient for the concurrency
 * level of this worker (2–4 VUs typical).
 */
import { Pool } from 'pg';
import { Logger } from 'winston';

export class JobDb {
  private pool: Pool | null = null;

  constructor(private readonly log: Logger) {
    const url = process.env['DATABASE_URL'];
    if (!url) {
      log.warn('DATABASE_URL not set — job status will not be updated in DB');
      return;
    }
    this.pool = new Pool({ connectionString: url, max: 2 });
  }

  /** Mark a job as completed with its artifact path and checksum. */
  async markCompleted(
    jobId:       string,
    storagePath: string,
    checksum:    string,
    execMs:      number,
  ): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `UPDATE render_jobs SET
           status            = 'completed',
           storage_path      = $2,
           computed_checksum = $3,
           execution_time_ms = $4,
           completed_at      = NOW()
         WHERE job_id = $1`,
        [jobId, storagePath, checksum, execMs],
      );
    } catch (err) {
      this.log.warn('DB markCompleted failed', { jobId, err });
    }
  }

  /** Mark a job as failed and increment retry_count. */
  async markFailed(jobId: string, errorMsg: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `UPDATE render_jobs SET
           status       = 'failed',
           error_log    = $2,
           retry_count  = retry_count + 1,
           completed_at = NOW()
         WHERE job_id = $1`,
        [jobId, errorMsg],
      );
    } catch (err) {
      this.log.warn('DB markFailed failed', { jobId, err });
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}
