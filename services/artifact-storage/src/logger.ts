import { createLogger as winstonLogger, format, transports } from 'winston';

export function createLogger(service: string) {
  return winstonLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    defaultMeta: { service },
    format: format.combine(
      format.timestamp(),
      format.errors({ stack: true }),
      format.json(),
    ),
    transports: [new transports.Console()],
  });
}
