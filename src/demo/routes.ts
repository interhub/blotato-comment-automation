import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { SIGNATURE_HEADER, signBody, type WebhookPayload } from "../domain/webhook.js";
import { HttpError, parseOr400 } from "../api/http.js";
import type { MockPlatform } from "../platform/mock.js";
import { DEMO_PLATFORM, definitionFromForm, ensureSandbox, loadSandboxState, type Sandbox } from "./sandbox.js";

export interface DemoOptions {
  pool: Db;
  webhookSecret: string;
  /** The worker's adapter; present only when API and worker share a process (`main.ts all`). */
  platform?: MockPlatform;
}

const publicDir = new URL("../../public/", import.meta.url);
const ASSETS: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/app.css": "app.css",
  "/favicon.svg": "favicon.svg",
};
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
};

const sandboxId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const username = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^@/, ""))
  .pipe(z.string().regex(/^[a-z0-9._]{1,30}$/, "username: letters, digits, dots and underscores, up to 30"));
const shortText = (max: number) => z.string().trim().min(1).max(max);

const commentBody = z.object({
  username,
  text: shortText(300),
  postId: z.string().regex(/^[a-z0-9-]{1,32}$/).default("post-1"),
  copies: z.number().int().min(1).max(3).default(1),
});

const messageBody = z
  .object({
    username,
    text: z.string().trim().max(300).default(""),
    attachments: z
      .array(z.object({ type: z.enum(["sticker", "image"]) }))
      .max(3)
      .default([]),
  })
  .refine((m) => m.text !== "" || m.attachments.length > 0, "a message needs text or an attachment");

const faultsBody = z.object({
  transient: z.number().int().min(0).max(3).default(0),
  permanent: z.boolean().default(false),
});

const automationBody = z.object({
  keywords: z.array(shortText(40)).min(1).max(5),
  replyText: shortText(300),
  prompt: shortText(300),
  finalText: shortText(300),
  timeoutSeconds: z.number().int().min(15).max(900),
});

const writeRoute = { bodyLimit: 4096 };

/**
 * Playground backend. Comments and DMs are signed and sent through the real webhook endpoint,
 * edits go through PUT /automations/:id, so the demo exercises the same paths as production traffic.
 */
export async function demoRoutes(app: FastifyInstance, opts: DemoOptions) {
  const { pool, webhookSecret, platform } = opts;
  await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });

  for (const [path, file] of Object.entries(ASSETS)) {
    app.get(path, { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (_req, reply) => {
      const body = await readFile(new URL(file, publicDir));
      return reply.type(MIME[file.split(".").pop()!]!).header("cache-control", "no-cache").send(body);
    });
  }

  async function sandboxOf(params: unknown): Promise<Sandbox> {
    const parsed = z.object({ sandbox: sandboxId }).safeParse(params);
    if (!parsed.success) throw new HttpError(404, "not found");
    return ensureSandbox(pool, parsed.data.sandbox);
  }

  /** Signs like the platform does and delivers `copies` times in parallel with the same event id. */
  async function deliver(payload: WebhookPayload, copies: number) {
    const body = JSON.stringify(payload);
    const responses = await Promise.all(
      Array.from({ length: copies }, () =>
        app.inject({
          method: "POST",
          url: `/webhooks/${DEMO_PLATFORM}`,
          headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(body, webhookSecret) },
          payload: body,
        }),
      ),
    );
    return responses.map((res) => ({ statusCode: res.statusCode, duplicate: res.json<{ duplicate?: boolean }>().duplicate ?? null }));
  }

  // Polled every second by each open tab, so it stays out of the request log.
  const stateRoute = { logLevel: "warn" as const, config: { rateLimit: { max: 300, timeWindow: "1 minute" } } };
  app.get("/demo/:sandbox/state", stateRoute, async (req) => {
    const sandbox = await sandboxOf(req.params);
    const state = await loadSandboxState(pool, sandbox);
    return { ...state, faultsArmed: platform?.pendingFailures(sandbox.externalAccountId) ?? [], faultsSupported: !!platform };
  });

  app.post("/demo/:sandbox/comment", writeRoute, async (req) => {
    const sandbox = await sandboxOf(req.params);
    const body = parseOr400(commentBody, req.body);
    const commentId = `c-${randomUUID()}`;
    const eventId = `demo-evt-${randomUUID()}`;
    const deliveries = await deliver(
      {
        eventId,
        type: "comment",
        accountId: sandbox.externalAccountId,
        from: { id: body.username, username: body.username },
        comment: { id: commentId, postId: body.postId, text: body.text },
      },
      body.copies,
    );
    return { eventId, commentId, deliveries };
  });

  app.post("/demo/:sandbox/message", writeRoute, async (req) => {
    const sandbox = await sandboxOf(req.params);
    const body = parseOr400(messageBody, req.body);
    const eventId = `demo-evt-${randomUUID()}`;
    const deliveries = await deliver(
      {
        eventId,
        type: "message",
        accountId: sandbox.externalAccountId,
        from: { id: body.username, username: body.username },
        message: { id: `m-${randomUUID()}`, text: body.text, attachments: body.attachments },
      },
      1,
    );
    return { eventId, deliveries };
  });

  app.post("/demo/:sandbox/faults", writeRoute, async (req) => {
    const sandbox = await sandboxOf(req.params);
    const body = parseOr400(faultsBody, req.body);
    if (!platform) throw new HttpError(409, "fault injection needs the API and the worker in one process (main.ts all)");
    const accountId = sandbox.externalAccountId;
    platform.clearFailures(accountId);
    if (body.transient > 0) platform.fail({ kind: "transient", times: body.transient, accountId });
    if (body.permanent) platform.fail({ kind: "permanent", accountId });
    return { faultsArmed: platform.pendingFailures(accountId) };
  });

  app.put("/demo/:sandbox/automation", writeRoute, async (req, reply) => {
    const sandbox = await sandboxOf(req.params);
    const form = parseOr400(automationBody, req.body);
    const res = await app.inject({
      method: "PUT",
      url: `/automations/${sandbox.automationId}`,
      payload: { definition: definitionFromForm(form) },
    });
    return reply.code(res.statusCode).type("application/json").send(res.body);
  });
}
