// src/core/logger.ts
// Stub file — Agent A owns the implementation.

import pino from 'pino';

const logLevel = process.env['ALCHEMY_LOG_LEVEL'] ?? 'info';

export function createLogger(name: string): pino.Logger {
  return pino({
    name,
    level: logLevel,
    transport:
      process.env['NODE_ENV'] !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}
