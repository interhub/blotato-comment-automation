import { run as runWorker, type Runner } from "graphile-worker";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createLogger, graphileLogger } from "./logger.js";
import { PLATFORMS, type SocialPlatform } from "./platform/types.js";
import { MockPlatform } from "./platform/mock.js";
import { createTaskList, cronItems } from "./worker/tasks.js";
import { demoCronItems, demoTaskList } from "./demo/tasks.js";

const role = process.argv[2] ?? "all";
if (!["api", "worker", "all"].includes(role)) throw new Error(`unknown role "${role}", expected api | worker | all`);

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, (error) => logger.error({ err: error }, "idle postgres client error"));
let app: FastifyInstance | undefined;
let runner: Runner | undefined;

// The prototype ships only mock adapters; a real client implements the same interface.
const mocks = new Map<string, MockPlatform>();
for (const name of PLATFORMS) {
  const mock = new MockPlatform();
  mock.onCall = (call) => logger.info({ platform: name, call }, "mock platform call");
  mocks.set(name, mock);
}
const platforms: Record<string, SocialPlatform> = Object.fromEntries(mocks);

if (role !== "worker") {
  // Scripted failures reach the worker only when both share this process.
  const demo = config.demoMode ? { platform: role === "all" ? mocks.get("instagram") : undefined } : undefined;
  app = await buildApp({ pool, webhookSecret: config.webhookSecret, logger, trustProxy: config.trustProxy, demo });
  await app.listen({ host: config.host, port: config.port });
}

if (role !== "api") {
  const deps = { pool, platforms, retry: config.retry, advanceRunMaxAttempts: config.advanceRunMaxAttempts, logger };
  runner = await runWorker({
    pgPool: pool,
    concurrency: config.workerConcurrency,
    noHandleSignals: true,
    parsedCronItems: config.demoMode ? [...cronItems, ...demoCronItems] : cronItems,
    logger: graphileLogger(logger),
    taskList: { ...createTaskList(deps), ...(config.demoMode ? demoTaskList(pool, logger) : {}) },
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
