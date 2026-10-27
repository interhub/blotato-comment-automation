import type { Queryable } from "../db.js";

export interface RunInput {
  id: string;
  text: string;
  attachments: number;
}

/** Only a message received after the current question went out answers it. */
const IN_OPEN_WINDOW = `
  run_id = $1 and consumed_at is null
  and received_at >= (select input_opened_at from runs where id = $1)`;

export async function nextInput(db: Queryable, runId: string): Promise<RunInput | undefined> {
  const { rows } = await db.query<RunInput>(
    `select id, text, attachments from run_inputs where ${IN_OPEN_WINDOW} order by received_at, id limit 1`,
    [runId],
  );
  return rows[0];
}

export async function hasPendingInput(db: Queryable, runId: string): Promise<boolean> {
  const { rowCount } = await db.query(`select 1 from run_inputs where ${IN_OPEN_WINDOW} limit 1`, [runId]);
  return rowCount === 1;
}

export async function consumeInput(db: Queryable, inputId: string): Promise<void> {
  await db.query("update run_inputs set consumed_at = now() where id = $1", [inputId]);
}

/** A finished step owns everything sent while it was open, so nothing leaks into the next question. */
export async function consumeAllInputs(db: Queryable, runId: string): Promise<void> {
  await db.query("update run_inputs set consumed_at = now() where run_id = $1 and consumed_at is null", [runId]);
}
