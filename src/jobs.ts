import type { Queryable } from "./db.js";

export type TaskName = "process_event" | "advance_run" | "wait_timeout" | "gc_job_queues";

/** Absolute time, or a delay measured on the database clock: one or the other, never both clocks. */
type JobOptions = { queueName?: string; jobKey?: string } & (
  | { runAt: Date; delayMs?: never }
  | { delayMs?: number; runAt?: never }
);

/**
 * Enqueues through SQL so the job commits in the same transaction as the state change
 * that caused it: no "state saved, job lost" window and no outbox table.
 */
export async function addJob(db: Queryable, task: TaskName, payload: object, options: JobOptions = {}): Promise<void> {
  await db.query(
    `select graphile_worker.add_job(
       identifier => $1,
       payload => $2::json,
       queue_name => $3,
       run_at => coalesce($4::timestamptz, now() + make_interval(secs => $5::float8 / 1000)),
       job_key => $6)`,
    [
      task,
      JSON.stringify(payload),
      options.queueName ?? null,
      options.runAt ?? null,
      options.delayMs ?? 0,
      options.jobKey ?? null,
    ],
  );
}

export const runQueue = (runId: string) => `run:${runId}`;

/** All jobs of one run share a named queue, so two workers never execute the same run at once. */
export async function enqueueAdvance(db: Queryable, runId: string, delayMs = 0): Promise<void> {
  await addJob(db, "advance_run", { runId }, { queueName: runQueue(runId), delayMs, jobKey: `run:${runId}:advance` });
}

const timeoutKey = (runId: string) => `run:${runId}:timeout`;

export async function enqueueTimeout(db: Queryable, runId: string, stepIndex: number, runAt: Date): Promise<void> {
  await addJob(db, "wait_timeout", { runId, stepIndex }, { queueName: runQueue(runId), runAt, jobKey: timeoutKey(runId) });
}

export async function cancelTimeout(db: Queryable, runId: string): Promise<void> {
  await db.query("select graphile_worker.remove_job($1)", [timeoutKey(runId)]);
}
