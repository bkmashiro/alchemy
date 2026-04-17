// src/core/logger.ts

import pino from 'pino';

const logLevel = process.env['ALCHEMY_LOG_LEVEL'] ?? 'info';

const transport =
  process.env['NODE_ENV'] !== 'production'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

/**
 * Create the application logger. Uses pino with pino-pretty in dev.
 *
 * Usage:
 *   import { createLogger } from './logger.js';
 *   const logger = createLogger('SlurmSSH');
 *   logger.info({ jobId }, 'Job submitted');
 */
export function createLogger(name: string): pino.Logger {
  return pino(
    {
      level: logLevel,
      name,
    },
    transport ? pino.transport(transport) : undefined,
  );
}
