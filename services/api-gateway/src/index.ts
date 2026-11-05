import Fastify from 'fastify';
import { buildApp } from './app';
import { Config }   from './config';
import { createLogger } from './logger';

const log = createLogger('api-gateway');

async function main(): Promise<void> {
  const cfg = Config.fromEnv();
  const app = await buildApp(cfg, log);

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  log.info(`api-gateway listening on :${cfg.port}`);

  const shutdown = async (): Promise<void> => {
    log.info('shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
