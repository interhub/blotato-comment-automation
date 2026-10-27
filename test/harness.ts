import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { runOnce } from "graphile-worker";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { RetryPolicy } from "../src/config.js";
import { createPool } from "../src/db.js";
import { SIGNATURE_HEADER, signBody } from "../src/domain/webhook.js";
import { silentGraphileLogger } from "../src/logger.js";
import { MockPlatform } from "../src/platform/mock.js";
import type { WorkerDeps } from "../src/worker/deps.js";
import { createTaskList } from "../src/worker/tasks.js";
import { TEST_DATABASE_URL } from "./db.js";

export const ACCOUNT = "biz-account-1";
const SECRET = "test-secret";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function pricingDefinition(collect: Record<string, unknown> = {}) {
  return {
    trigger: { type: "comment_keyword", keywords: ["pricing"], postIds: null },
    steps: [
      { type: "reply_to_comment", text: "Sent you a DM!" },
      {
        type: "collect_input",
        prompt: "Hey {{username}}! What's the best email to send the pricing to?",
        validate: "email",
        saveAs: "email",
        timeoutSeconds: 86_400,
        maxReprompts: 3,
        ...collect,
      },
      { type: "send_dm", text: "Here you go: https://example.com/pricing?e={{email|url}}" },
    ],
  };
}

export const pricingLink = (email: string) => `Here you go: https://example.com/pricing?e=${encodeURIComponent(email)}`;

export interface RunRow {
  id: string;
  automation_id: string;
  automation_version: number;
  contact_id: string;
  status: string;
  outcome: string | null;
  current_step: number;
  last_error: string | null;
  trigger_comment_id: string;
}

/**
 * Real Fastify app + real worker task list + MockPlatform against the test database.
 * Registers the vitest hooks, so call it once at the top of a test file.
 */
export function useHarness(retry: Partial<RetryPolicy> = {}, options: { demo?: boolean } = {}) {
  const pool = createPool(TEST_DATABASE_URL);
  const mock = new MockPlatform();
  const logger = pino({ level: "silent" });
  const deps: WorkerDeps = {
    pool,
    platforms: { instagram: mock },
    retry: { baseMs: 20, capMs: 1_000, maxAttempts: 4, ...retry },
    advanceRunMaxAttempts: 2,
    logger,
  };
  const taskList = createTaskList(deps);
  let app!: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ pool, webhookSecret: SECRET, logger, demo: options.demo ? { platform: mock } : undefined });
  });
  beforeEach(async () => {
    mock.reset();
    await pool.query(`
      truncate social_accounts, automations, automation_versions, inbound_events, runs, run_inputs, outbound_actions cascade;
      truncate graphile_worker._private_jobs, graphile_worker._private_job_queues cascade;`);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function postWebhook(payload: object, signature?: string) {
    const body = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: "/webhooks/instagram",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature ?? signBody(body, SECRET) },
      payload: body,
    });
  }

  /**
   * graphile-worker records a finished job without awaiting it, so runOnce can resolve while
   * the last job row is still locked. Nothing else runs jobs in tests, so wait for the locks to clear.
   */
  async function settledJobState() {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await pool.query<{ locked: number; errors: string | null; next_in_ms: number | null }>(
        `select count(*) filter (where locked_at is not null)::int as locked,
                string_agg(task_identifier || ': ' || last_error, '; ') filter (where last_error is not null) as errors,
                (extract(epoch from min(run_at) - now()) * 1000)::float8 as next_in_ms
         from graphile_worker.jobs`,
      );
      const state = rows[0]!;
      if (state.locked === 0) return { errors: state.errors, nextInMs: state.next_in_ms };
      if (Date.now() > deadline) throw new Error("jobs stayed locked after runOnce finished");
      await sleep(2);
    }
  }

  return {
    pool,
    mock,
    deps,
    get app() {
      return app;
    },
    postWebhook,

    async createAutomation(definition: object = pricingDefinition(), name = "Pricing DM") {
      const res = await app.inject({
        method: "POST",
        url: "/automations",
        payload: { platform: "instagram", accountId: ACCOUNT, name, definition },
      });
      if (res.statusCode !== 201) throw new Error(`create automation failed: ${res.body}`);
      return res.json<{ id: string; version: number }>();
    },

    comment(opts: { user: string; text: string; postId?: string; commentId?: string; eventId?: string }) {
      const commentId = opts.commentId ?? randomUUID();
      return postWebhook({
        eventId: opts.eventId ?? `comment-event-${commentId}`,
        type: "comment",
        accountId: ACCOUNT,
        from: { id: opts.user, username: opts.user },
        comment: { id: commentId, postId: opts.postId ?? "post-1", text: opts.text },
      });
    },

    dm(opts: { user: string; text: string; attachments?: number; eventId?: string }) {
      const messageId = randomUUID();
      return postWebhook({
        eventId: opts.eventId ?? `message-event-${messageId}`,
        type: "message",
        accountId: ACCOUNT,
        from: { id: opts.user, username: opts.user },
        message: {
          id: messageId,
          text: opts.text,
          attachments: Array.from({ length: opts.attachments ?? 0 }, () => ({ type: "image" })),
        },
      });
    },

    /**
     * Runs every job that is due now or within `horizonMs` (sleeping until scheduled ones
     * are due), until nothing is left in that window. Fails loudly if a task threw.
     */
    async drain(horizonMs = 1_000) {
      for (let round = 0; round < 500; round++) {
        await runOnce({ pgPool: pool, taskList, concurrency: 4, noHandleSignals: true, logger: silentGraphileLogger });
        const { errors, nextInMs } = await settledJobState();
        if (errors) throw new Error(`job failed: ${errors}`);
        if (nextInMs === null || nextInMs > horizonMs) return;
        await sleep(Math.max(0, nextInMs) + 5);
      }
      throw new Error("drain did not settle");
    },

    /**
     * One worker pass with every scheduled job made due first, skipping graphile's own retry
     * backoff. Unlike drain it tolerates task errors and returns them.
     */
    async runJobsNow(): Promise<string | null> {
      await pool.query("update graphile_worker._private_jobs set run_at = now() where locked_at is null");
      await runOnce({ pgPool: pool, taskList, concurrency: 4, noHandleSignals: true, logger: silentGraphileLogger });
      return (await settledJobState()).errors;
    },

    /** Moves a waiting run's deadline and its timeout job to now. */
    async reachDeadline(runId: string) {
      await pool.query("update runs set wait_deadline = now() where id = $1", [runId]);
      await pool.query("update graphile_worker._private_jobs set run_at = now() where key = $1", [`run:${runId}:timeout`]);
    },

    async eventId(externalEventId: string): Promise<string> {
      const { rows } = await pool.query<{ id: string }>("select id from inbound_events where external_event_id = $1", [
        externalEventId,
      ]);
      return rows[0]!.id;
    },

    async runs(): Promise<RunRow[]> {
      const { rows } = await pool.query<RunRow>("select * from runs order by created_at, id");
      return rows;
    },

    async runView(id: string) {
      const res = await app.inject({ method: "GET", url: `/runs/${id}` });
      return res.json<{
        run: { status: string; outcome: string | null; lastError: string | null; context: { vars: Record<string, string> } };
        inputs: { text: string; consumedAt: string | null }[];
        outboundActions: {
          idempotencyKey: string;
          kind: string;
          request: Record<string, string>;
          status: string;
          attempts: number;
          lastError: string | null;
          attemptLog: { attempt: number; retryInMs: number | null; kind: string }[];
        }[];
      }>();
    },
  };
}

export type Harness = ReturnType<typeof useHarness>;
