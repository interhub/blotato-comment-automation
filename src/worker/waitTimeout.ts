import { lockContact, withTransaction } from "../db.js";
import type { WorkerDeps } from "./deps.js";
import { hasPendingInput } from "./inputs.js";
import { closeRun, loadRun } from "./runs.js";

/**
 * Closes a run that waited too long. Serializes with DM routing on the contact lock, so a
 * reply and a timeout in the same instant resolve to whichever commits first.
 */
export async function waitTimeout(deps: WorkerDeps, runId: string, stepIndex: number): Promise<void> {
  const run = await loadRun(deps.pool, runId);
  if (!run) return;

  const closed = await withTransaction(deps.pool, async (client) => {
    await lockContact(client, run.accountId, run.contactId);
    const { rows } = await client.query<{ status: string; current_step: number; due: boolean }>(
      "select status, current_step, wait_deadline <= now() as due from runs where id = $1",
      [runId],
    );
    const state = rows[0];
    if (!state || state.status !== "waiting" || state.current_step !== stepIndex || !state.due) return false;
    if (await hasPendingInput(client, runId)) return false;
    return closeRun(client, run, { status: "timed_out" });
  });
  if (closed) deps.logger.info({ runId, automationId: run.automationId }, "run timed out");
}
