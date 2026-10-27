import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { automationRoutes } from "./automations.js";
import { runRoutes } from "./runs.js";
import { webhookRoutes } from "./webhooks.js";

export interface AppOptions {
  pool: Db;
  webhookSecret: string;
  logger: FastifyBaseLogger;
}

export async function buildApp({ pool, webhookSecret, logger }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger });

  app.get("/health", async () => {
    await pool.query("select 1");
    return { ok: true };
  });
  await app.register(webhookRoutes, { pool, webhookSecret });
  await app.register(automationRoutes, { pool });
  await app.register(runRoutes, { pool });

  return app;
}
