export interface RetryPolicy {
  baseMs: number;
  capMs: number;
  maxAttempts: number;
}

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  webhookSecret: string;
  workerConcurrency: number;
  /** Attempts of an advance_run job that crashed with a non-platform error before its run is failed. */
  advanceRunMaxAttempts: number;
  logLevel: string;
  retry: RetryPolicy;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

const DEV_WEBHOOK_SECRET = "dev-webhook-secret";

/** The dev default is public in this repo, so production refuses to start with it. */
function webhookSecret(): string {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") throw new Error("WEBHOOK_SECRET must be set when NODE_ENV=production");
  return DEV_WEBHOOK_SECRET;
}

export function loadConfig(): Config {
  return {
    databaseUrl: process.env.DATABASE_URL ?? "postgres://app:app@localhost:54329/comment_automation",
    host: process.env.HOST ?? "127.0.0.1",
    port: int("PORT", 3000),
    webhookSecret: webhookSecret(),
    workerConcurrency: int("WORKER_CONCURRENCY", 5),
    advanceRunMaxAttempts: int("ADVANCE_RUN_MAX_ATTEMPTS", 5),
    logLevel: process.env.LOG_LEVEL ?? "info",
    retry: {
      baseMs: int("RETRY_BASE_MS", 1_000),
      capMs: int("RETRY_CAP_MS", 60_000),
      maxAttempts: int("RETRY_MAX_ATTEMPTS", 5),
    },
  };
}
