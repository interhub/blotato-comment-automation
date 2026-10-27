import type pg from "pg";
import { lockContact, withTransaction } from "../db.js";
import type { Definition } from "../domain/definition.js";
import { matchesKeyword } from "../domain/keywords.js";
import type { CommentPayload, MessagePayload, WebhookPayload } from "../domain/webhook.js";
import { enqueueAdvance } from "../jobs.js";
import type { WorkerDeps } from "./deps.js";
import type { RunContext } from "./runs.js";

interface InboundEvent {
  id: string;
  platform: string;
  payload: WebhookPayload;
}

interface Account {
  id: string;
}

/** Turns a stored webhook into runs (comments) or run inputs (DMs). Safe to execute twice. */
export async function processEvent(deps: WorkerDeps, eventId: string): Promise<void> {
  const { rows } = await deps.pool.query<InboundEvent>(
    "select id, platform, payload from inbound_events where id = $1 and processed_at is null",
    [eventId],
  );
  const event = rows[0];
  if (!event) return;
  const { payload } = event;

  const { rows: accounts } = await deps.pool.query<Account>(
    "select id from social_accounts where platform = $1 and external_account_id = $2",
    [event.platform, payload.accountId],
  );
  const account = accounts[0];
  // Our own comments and DMs come back as webhooks too; acting on them would loop.
  const ignored = !account || payload.from.id === payload.accountId;

  await withTransaction(deps.pool, async (client) => {
    const { rowCount } = await client.query(
      "update inbound_events set processed_at = now() where id = $1 and processed_at is null",
      [event.id],
    );
    if (!rowCount || ignored) return;
    if (payload.type === "comment") await handleComment(deps, client, account, payload);
    else await handleMessage(deps, client, account, event, payload);
  });
}

async function handleComment(deps: WorkerDeps, client: pg.PoolClient, account: Account, payload: CommentPayload) {
  const { rows: automations } = await client.query<{ id: string; version: number; definition: Definition }>(
    `select a.id, a.current_version as version, v.definition
     from automations a
     join automation_versions v on v.automation_id = a.id and v.version = a.current_version
     where a.account_id = $1 and a.status = 'active'
     order by a.created_at, a.id`,
    [account.id],
  );
  const matched = automations.filter(({ definition: { trigger } }) => {
    const postMatches = trigger.postIds === null || trigger.postIds.includes(payload.comment.postId);
    return postMatches && matchesKeyword(payload.comment.text, trigger.keywords);
  });
  if (matched.length === 0) return;

  const contactId = payload.from.id;
  await lockContact(client, account.id, contactId);
  const { rows: live } = await client.query(
    "select 1 from runs where account_id = $1 and contact_id = $2 and status in ('running', 'waiting')",
    [account.id, contactId],
  );
  let personBusy = live.length > 0;

  for (const automation of matched) {
    const status = personBusy ? "queued" : "running";
    const context: RunContext = { vars: { username: payload.from.username }, replies: 0 };
    const { rows } = await client.query<{ id: string }>(
      `insert into runs (automation_id, automation_version, account_id, contact_id, trigger_comment_id, status, context)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (automation_id, trigger_comment_id) do nothing
       returning id`,
      [automation.id, automation.version, account.id, contactId, payload.comment.id, status, context],
    );
    const runId = rows[0]?.id;
    if (!runId) continue;
    if (status === "running") {
      await enqueueAdvance(client, runId);
      personBusy = true;
    }
    deps.logger.info({ runId, automationId: automation.id, status }, "run created");
  }
}

async function handleMessage(
  deps: WorkerDeps,
  client: pg.PoolClient,
  account: Account,
  event: InboundEvent,
  payload: MessagePayload,
) {
  await lockContact(client, account.id, payload.from.id);
  // Only a message received after the question's window opened counts as an answer.
  // Timestamps are compared in SQL to keep Postgres' microsecond precision.
  const { rows } = await client.query<{ id: string; status: string }>(
    `select id, status from runs
     where account_id = $1 and contact_id = $2 and status in ('running', 'waiting')
       and input_opened_at <= (select received_at from inbound_events where id = $3)`,
    [account.id, payload.from.id, event.id],
  );
  const run = rows[0];
  if (!run) {
    deps.logger.info({ eventId: event.id }, "message without an open conversation, ignored");
    return;
  }

  const { rowCount } = await client.query(
    `insert into run_inputs (run_id, inbound_event_id, text, attachments, received_at)
     select $1, id, $3, $4, received_at from inbound_events where id = $2
     on conflict (inbound_event_id) do nothing`,
    [run.id, event.id, payload.message.text, payload.message.attachments.length],
  );
  // A running run picks the input up itself when it reaches its wait point.
  if (rowCount && run.status === "waiting") {
    await client.query("update runs set status = 'running', updated_at = now() where id = $1", [run.id]);
    await enqueueAdvance(client, run.id);
  }
  deps.logger.info({ eventId: event.id, runId: run.id }, "message routed to run");
}
