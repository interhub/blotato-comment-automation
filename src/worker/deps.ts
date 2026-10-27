import type { RetryPolicy } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../logger.js";
import type { SocialPlatform } from "../platform/types.js";

export interface WorkerDeps {
  pool: Db;
  platforms: Record<string, SocialPlatform>;
  retry: RetryPolicy;
  advanceRunMaxAttempts: number;
  logger: Logger;
}
