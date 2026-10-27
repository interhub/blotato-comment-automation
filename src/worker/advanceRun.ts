import { lockContact, withTransaction } from "../db.js";
import { enqueueAdvance, enqueueTimeout } from "../jobs.js";
import type { Logger } from "../logger.js";
import { PRIVATE_REPLY_WINDOW } from "../platform/types.js";
import type { WorkerDeps } from "./deps.js";
import { consumeAllInputs, hasPendingInput } from "./inputs.js";
import { closeRun, loadRun, type Run, type RunContext } from "./runs.js";
import { executeStep, type StepResult } from "./steps.js";

/**
 * Executes steps of one run until it has to wait, retry or finish. Runs inside the
 * run's named queue, so it is never executed twice in parallel for the same run;
 * a stale job sees a non-running run and exits.
 */
export async function advanceRun(deps: WorkerDeps, runId: string): Promise<void> {
  for (;;) {
    const run = await loadRun(deps.pool, runId);
    if (!run || run.status !== "running") return;
    const log = deps.logger.child({ runId, automationId: run.automationId, step: run.currentStep });

    if (run.currentStep === 0 && (await closeIfExpired(deps, run))) {
      log.warn("run expired before its first message");
      return;
    }

    if (run.currentStep >= run.definition.steps.length) {
      await withTransaction(deps.pool, async (client) => {
        await lockContact(client, run.accountId, run.contactId);
        await closeRun(client, run, { status: "completed" });
      });
      log.info("run completed");
      return;
    }

    const result = await executeStep(deps, run);
    log.info({ result: result.type }, "step executed");
    if (!(await apply(deps, run, result, log))) return;
  }
}

/**
 * A run that sat in the queue past the private-reply window can no longer open the DM
 * conversation, so it ends before replying to the comment publicly. The run is created
 * when the comment arrives, so its created_at stands in for the comment's time.
 */
async function closeIfExpired(deps: WorkerDeps, run: Run): Promise<boolean> {
  return withTransaction(deps.pool, async (client) => {
    await lockContact(client, run.accountId, run.contactId);
    const { rowCount } = await client.query(
      `select 1 from runs
       where id = $1 and status = 'running' and current_step = 0 and created_at <= now() - $2::interval`,
      [run.id, PRIVATE_REPLY_WINDOW],
    );
    if (!rowCount) return false;
    return closeRun(client, run, {
      status: "failed",
      outcome: "expired",
      lastError: `trigger comment is older than the ${PRIVATE_REPLY_WINDOW} private reply window`,
    });
  });
}

/** Persists a step result. Returns true when the loop should continue with the next step. */
async function apply(deps: WorkerDeps, run: Run, result: StepResult, log: Logger): Promise<boolean> {
  const { pool } = deps;
  switch (result.type) {
    case "next": {
      const context: RunContext = { vars: { ...run.context.vars, ...result.vars }, replies: 0 };
      return withTransaction(pool, async (client) => {
        // Closing the input window takes the DM routing lock, like opening it does.
        await lockContact(client, run.accountId, run.contactId);
        const { rowCount } = await client.query(
          `update runs
           set current_step = current_step + 1, context = $3, outcome = coalesce($4, outcome),
               input_opened_at = null, wait_deadline = null, last_error = null, updated_at = now()
           where id = $1 and status = 'running' and current_step = $2`,
          [run.id, run.currentStep, context, result.outcome ?? null],
        );
        if (rowCount) await consumeAllInputs(client, run.id);
        return rowCount === 1;
      });
    }

    case "wait":
      return withTransaction(pool, async (client) => {
        // Same lock as DM routing: a reply either lands before this check or sees "waiting" and wakes us.
        await lockContact(client, run.accountId, run.contactId);
        if (await hasPendingInput(client, run.id)) return true;
        const { rows } = await client.query<{ wait_deadline: Date }>(
          `update runs
           set status = 'waiting', wait_deadline = now() + make_interval(secs => $3), last_error = null, updated_at = now()
           where id = $1 and status = 'running' and current_step = $2
           returning wait_deadline`,
          [run.id, run.currentStep, result.timeoutSeconds],
        );
        if (rows[0]) await enqueueTimeout(client, run.id, run.currentStep, rows[0].wait_deadline);
        return false;
      });

    case "done":
      await withTransaction(pool, async (client) => {
        await lockContact(client, run.accountId, run.contactId);
        await consumeAllInputs(client, run.id);
        await closeRun(client, run, { status: "completed", outcome: result.outcome });
      });
      log.info({ outcome: result.outcome }, "run finished");
      return false;

    case "retry":
      await withTransaction(pool, async (client) => {
        const { rowCount } = await client.query(
          "update runs set last_error = $2, updated_at = now() where id = $1 and status = 'running'",
          [run.id, result.error],
        );
        if (rowCount) await enqueueAdvance(client, run.id, result.delayMs);
      });
      log.warn({ error: result.error, delayMs: result.delayMs }, "step will be retried");
      return false;

    case "fail":
      await withTransaction(pool, async (client) => {
        await lockContact(client, run.accountId, run.contactId);
        await closeRun(client, run, { status: "failed", lastError: result.error });
      });
      log.error({ error: result.error }, "run failed");
      return false;
  }
}
