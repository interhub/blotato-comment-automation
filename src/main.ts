import { run as runWorker, type Runner } from "graphile-worker";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createLogger, graphileLogger } from "./logger.js";
import { PLATFORMS, type SocialPlatform } from "./platform/types.js";
import { MockPlatform } from "./platform/mock.js";
import { createTaskList, cronItems } from "./worker/tasks.js";

const role = process.argv[2] ?? "all";
if (!["api", "worker", "all"].includes(role)) throw new Error(`unknown role "${role}", expected api | worker | all`);

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, (error) => logger.error({ err: error }, "idle postgres client error"));
let app: FastifyInstance | undefined;
let runner: Runner | undefined;

if (role !== "worker") {
  app = await buildApp({ pool, webhookSecret: config.webhookSecret, logger });
  await app.listen({ host: config.host, port: config.port });
}

if (role !== "api") {
  // The prototype ships only mock adapters; a real client implements the same interface.
  const platforms: Record<string, SocialPlatform> = {};
  for (const name of PLATFORMS) {
    const mock = new MockPlatform();
    mock.onCall = (call) => logger.info({ platform: name, call }, "mock platform call");
    platforms[name] = mock;
  }
  runner = await runWorker({
    pgPool: pool,
    concurrency: config.workerConcurrency,
    noHandleSignals: true,
    parsedCronItems: cronItems,
    logger: graphileLogger(logger),
    taskList: createTaskList({
      pool,
      platforms,
      retry: config.retry,
      advanceRunMaxAttempts: config.advanceRunMaxAttempts,
      logger,
    }),
  });
}

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  await app?.close();
  await runner?.stop();
  await pool.end();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
