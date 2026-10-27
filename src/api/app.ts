import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { demoRoutes, type DemoOptions } from "../demo/routes.js";
import { automationRoutes } from "./automations.js";
import { runRoutes } from "./runs.js";
import { webhookRoutes } from "./webhooks.js";

export interface AppOptions {
  pool: Db;
  webhookSecret: string;
  logger: FastifyBaseLogger;
  /** Reverse proxy hops to trust for the client address. */
  trustProxy?: number;
  /** Mounts the playground and /demo routes; off unless DEMO_MODE=true. */
  demo?: Pick<DemoOptions, "platform">;
}

export async function buildApp({ pool, webhookSecret, logger, trustProxy, demo }: AppOptions): Promise<FastifyInstance> {
  const hops = trustProxy ?? 0;
  const app = Fastify({ loggerInstance: logger, trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false });

  app.get("/health", { logLevel: "warn" }, async () => {
    await pool.query("select 1");
    return { ok: true };
  });
  await app.register(webhookRoutes, { pool, webhookSecret });
  await app.register(automationRoutes, { pool });
  await app.register(runRoutes, { pool });
  if (demo) await app.register(demoRoutes, { pool, webhookSecret, platform: demo.platform });

  return app;
}
