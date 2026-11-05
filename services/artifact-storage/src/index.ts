import { NotificationWorker } from './notification-worker';
import { Config }             from './config';
import { createLogger }       from './logger';

const log = createLogger('artifact-storage');

async function main(): Promise<void> {
  const cfg    = Config.fromEnv();
  const worker = new NotificationWorker(cfg, log);

  process.on('SIGTERM', () => worker.shutdown());
  process.on('SIGINT',  () => worker.shutdown());

  log.info('artifact-storage / webhook dispatcher starting');
  await worker.run();
}

main().catch((err) => {
  console.error('Fatal', err);
  process.exit(1);
});
