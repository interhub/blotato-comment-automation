import type pg from "pg";
import { lockContact, withTransaction, type Db } from "../db.js";
import type { Definition } from "../domain/definition.js";
import { cancelTimeout, enqueueAdvance } from "../jobs.js";

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "timed_out";

export interface RunContext {
  /** Template variables: username plus everything collected so far. */
  vars: Record<string, string>;
  /** Replies consumed by the current step; numbers its outbound messages and rotates copy. */
  replies: number;
}

export interface Run {
  id: string;
  automationId: string;
  accountId: string;
  platform: string;
  externalAccountId: string;
  contactId: string;
  triggerCommentId: string;
  status: RunStatus;
  currentStep: number;
  context: RunContext;
  inputOpenedAt: Date | null;
  definition: Definition;
}

export async function loadRun(pool: Db, runId: string): Promise<Run | undefined> {
  const { rows } = await pool.query<Run>(
    `select r.id, r.automation_id as "automationId", r.account_id as "accountId", s.platform,
            s.external_account_id as "externalAccountId", r.contact_id as "contactId",
            r.trigger_comment_id as "triggerCommentId", r.status, r.current_step as "currentStep",
            r.context, r.input_opened_at as "inputOpenedAt", v.definition
     from runs r
     join social_accounts s on s.id = r.account_id
     join automation_versions v on v.automation_id = r.automation_id and v.version = r.automation_version
     where r.id = $1`,
    [runId],
  );
  return rows[0];
}

/**
 * Moves a live run to a final state and, in the same transaction, hands the person's
 * conversation slot to their oldest queued run. The caller must hold lockContact.
 */
export async function closeRun(
  client: pg.PoolClient,
  run: Pick<Run, "id" | "accountId" | "contactId">,
  fields: { status: "completed" | "failed" | "timed_out"; outcome?: string; lastError?: string },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update runs
     set status = $2, outcome = coalesce($3, outcome), last_error = $4, wait_deadline = null, updated_at = now()
     where id = $1 and status in ('running', 'waiting')`,
    [run.id, fields.status, fields.outcome ?? null, fields.lastError ?? null],
  );
  if (!rowCount) return false;
  await cancelTimeout(client, run.id);

  const { rows } = await client.query<{ id: string }>(
    `update runs set status = 'running', updated_at = now()
     where id = (select id from runs
                 where account_id = $1 and contact_id = $2 and status = 'queued'
                 order by created_at, id limit 1)
     returning id`,
    [run.accountId, run.contactId],
  );
  if (rows[0]) await enqueueAdvance(client, rows[0].id);
  return true;
}

/** Fails a live run from outside its step logic (a job that keeps crashing); promotes the queue like any close. */
export async function failRun(pool: Db, runId: string, error: string): Promise<boolean> {
  const run = await loadRun(pool, runId);
  if (!run) return false;
  return withTransaction(pool, async (client) => {
    await lockContact(client, run.accountId, run.contactId);
    return closeRun(client, run, { status: "failed", lastError: error });
  });
}
