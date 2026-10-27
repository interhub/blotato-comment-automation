import { Logger as GraphileLogger } from "graphile-worker";
import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({ level });
}

export function graphileLogger(logger: Logger): GraphileLogger {
  return new GraphileLogger((scope) => (level, message, meta) => {
    const method = level === "warning" ? "warn" : level;
    logger[method]({ ...scope, ...meta }, message);
  });
}

export const silentGraphileLogger = new GraphileLogger(() => () => {});
