import { WorkerPool } from './worker-pool';
import { Config }     from './config';
import { createLogger } from './logger';

const log = createLogger('chromium-worker');

async function main(): Promise<void> {
  const cfg  = Config.fromEnv();
  const pool = new WorkerPool(cfg, log);

  log.info('chromium render worker starting', { concurrency: cfg.concurrency });

  process.on('SIGTERM', () => { log.info('SIGTERM received'); pool.shutdown(); });
  process.on('SIGINT',  () => { log.info('SIGINT received');  pool.shutdown(); });

  await pool.run();
}

main().catch((err) => {
  console.error('Fatal error', err);
  process.exit(1);
});
