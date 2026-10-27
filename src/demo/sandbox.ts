import { withTransaction, type Db } from "../db.js";
import type { Definition } from "../domain/definition.js";

/**
 * A sandbox is one browser's private demo: its own Instagram account with one seeded automation.
 * Everything the playground shows is read back from the same tables the worker writes.
 */
export const DEMO_PLATFORM = "instagram";
export const SANDBOX_TTL = "24 hours";

export const demoAccountId = (sandbox: string) => `demo-${sandbox}`;

export interface DemoForm {
  keywords: string[];
  replyText: string;
  prompt: string;
  finalText: string;
  timeoutSeconds: number;
}

export const SEED_FORM: DemoForm = {
  keywords: ["pricing", "price"],
  replyText: "Sent you a DM!",
  prompt: "Hey {{username}}! What's the best email to send the pricing to?",
  finalText: "Here you go: https://example.com/pricing?e={{email|url}}",
  timeoutSeconds: 120,
};

export function definitionFromForm(form: DemoForm): Definition {
  return {
    trigger: { type: "comment_keyword", keywords: form.keywords, postIds: null },
    steps: [
      { type: "reply_to_comment", text: form.replyText },
      {
        type: "collect_input",
        prompt: form.prompt,
        validate: "email",
        saveAs: "email",
        timeoutSeconds: form.timeoutSeconds,
        maxReprompts: 3,
      },
      { type: "send_dm", text: form.finalText },
    ],
  };
}

/** The playground edits the seeded shape only; anything else falls back to the seed values. */
function formFromDefinition(definition: Definition): DemoForm {
  const step = <T extends Definition["steps"][number]["type"]>(type: T) =>
    definition.steps.find((s): s is Extract<Definition["steps"][number], { type: T }> => s.type === type);
  return {
    keywords: definition.trigger.keywords,
    replyText: step("reply_to_comment")?.text ?? SEED_FORM.replyText,
    prompt: step("collect_input")?.prompt ?? SEED_FORM.prompt,
    finalText: step("send_dm")?.text ?? SEED_FORM.finalText,
    timeoutSeconds: step("collect_input")?.timeoutSeconds ?? SEED_FORM.timeoutSeconds,
  };
}

export interface Sandbox {
  accountId: string;
  externalAccountId: string;
  automationId: string;
}

/** Creates the sandbox's account and seeded automation on first use; cheap read afterwards. */
export async function ensureSandbox(pool: Db, sandbox: string): Promise<Sandbox> {
  const externalAccountId = demoAccountId(sandbox);
  const find = `select s.id as "accountId", a.id as "automationId"
                from social_accounts s
                join automations a on a.account_id = s.id
                where s.platform = $1 and s.external_account_id = $2
                order by a.created_at limit 1`;
  const existing = await pool.query<Omit<Sandbox, "externalAccountId">>(find, [DEMO_PLATFORM, externalAccountId]);
  if (existing.rows[0]) return { ...existing.rows[0], externalAccountId };

  return withTransaction(pool, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`demo:${sandbox}`]);
    const again = await client.query<Omit<Sandbox, "externalAccountId">>(find, [DEMO_PLATFORM, externalAccountId]);
    if (again.rows[0]) return { ...again.rows[0], externalAccountId };

    const { rows: accounts } = await client.query<{ id: string }>(
      `insert into social_accounts (platform, external_account_id) values ($1, $2)
       on conflict (platform, external_account_id) do update set platform = excluded.platform
       returning id`,
      [DEMO_PLATFORM, externalAccountId],
    );
    const accountId = accounts[0]!.id;
    const { rows } = await client.query<{ id: string }>(
      "insert into automations (account_id, name) values ($1, 'Pricing DM') returning id",
      [accountId],
    );
    const automationId = rows[0]!.id;
    await client.query("insert into automation_versions (automation_id, version, definition) values ($1, 1, $2)", [
      automationId,
      definitionFromForm(SEED_FORM),
    ]);
    return { accountId, externalAccountId, automationId };
  });
}

type Attempt = { attempt: number; at: string; error: string; kind: string; retryInMs: number | null };

export interface OutboundItem {
  kind: "comment_reply" | "dm_out";
  id: string;
  at: string;
  text: string;
  runId: string;
  stepIndex: number;
  status: string;
  attempts: number;
  attemptLog: Attempt[];
  lastError: string | null;
  /** comment_reply: the comment answered. dm_out: set when the DM went as a private reply to it. */
  commentId: string | null;
  mode: "private_reply" | "recipient_id" | null;
}

export type TimelineItem =
  | { kind: "comment"; id: string; at: string; text: string; postId: string; commentId: string }
  | { kind: "dm_in"; id: string; at: string; text: string; attachments: string[]; runId: string | null; consumed: boolean }
  | OutboundItem;

export interface RunView {
  id: string;
  username: string;
  triggerCommentId: string;
  postId: string | null;
  status: string;
  outcome: string | null;
  version: number;
  currentStep: number;
  stepCount: number;
  stepType: string | null;
  waitDeadline: string | null;
  queuePosition: number | null;
  lastError: string | null;
  vars: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface Person {
  username: string;
  timeline: TimelineItem[];
  runs: RunView[];
}

export interface SandboxState {
  serverTime: string;
  automation: { id: string; version: number; form: DemoForm };
  people: Person[];
}

interface EventRow {
  id: string;
  kind: "comment" | "message";
  payload: {
    from: { id: string };
    comment?: { id: string; postId: string; text: string };
    message?: { text: string; attachments: { type: string }[] };
  };
  received_at: Date;
  run_id: string | null;
  consumed_at: Date | null;
}

interface ActionRow {
  id: string;
  run_id: string;
  contact_id: string;
  step_index: number;
  kind: "comment_reply" | "dm";
  request: { text: string; commentId?: string };
  status: string;
  attempts: number;
  attempt_log: Attempt[];
  last_error: string | null;
  created_at: Date;
}

type RunRow = Omit<RunView, "username" | "postId" | "waitDeadline" | "createdAt" | "updatedAt"> & {
  username: string;
  waitDeadline: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const HISTORY_LIMIT = 300;

/** The playground's single polling endpoint: per person, what they sent, what we sent back, and each run. */
export async function loadSandboxState(pool: Db, sandbox: Sandbox): Promise<SandboxState> {
  const [automation, events, actions, runs] = await Promise.all([
    pool.query<{ version: number; definition: Definition; now: Date }>(
      `select a.current_version as version, v.definition, now()
       from automations a
       join automation_versions v on v.automation_id = a.id and v.version = a.current_version
       where a.id = $1`,
      [sandbox.automationId],
    ),
    pool.query<EventRow>(
      `select e.id, e.kind, e.payload, e.received_at, ri.run_id, ri.consumed_at
       from inbound_events e
       left join run_inputs ri on ri.inbound_event_id = e.id
       where e.platform = $1 and e.payload->>'accountId' = $2
       order by e.received_at desc, e.id limit ${HISTORY_LIMIT}`,
      [DEMO_PLATFORM, sandbox.externalAccountId],
    ),
    pool.query<ActionRow>(
      `select o.id, o.run_id, r.contact_id, o.step_index, o.kind, o.request, o.status, o.attempts,
              o.attempt_log, o.last_error, o.created_at
       from outbound_actions o
       join runs r on r.id = o.run_id
       where r.account_id = $1
       order by o.created_at desc, o.id limit ${HISTORY_LIMIT}`,
      [sandbox.accountId],
    ),
    pool.query<RunRow>(
      `select r.id, r.contact_id as username, r.trigger_comment_id as "triggerCommentId", r.status, r.outcome,
              r.automation_version as version, r.current_step as "currentStep",
              jsonb_array_length(v.definition->'steps') as "stepCount",
              v.definition->'steps'->r.current_step->>'type' as "stepType",
              r.wait_deadline as "waitDeadline", r.last_error as "lastError",
              coalesce(r.context->'vars', '{}') as vars,
              r.created_at as "createdAt", r.updated_at as "updatedAt",
              case when r.status = 'queued' then
                (select count(*)::int from runs q
                 where q.account_id = r.account_id and q.contact_id = r.contact_id and q.status = 'queued'
                   and (q.created_at, q.id) <= (r.created_at, r.id))
              end as "queuePosition"
       from runs r
       join automation_versions v on v.automation_id = r.automation_id and v.version = r.automation_version
       where r.account_id = $1
       order by r.created_at desc, r.id limit 100`,
      [sandbox.accountId],
    ),
  ]);

  const people = new Map<string, Person>();
  const person = (username: string) => {
    let entry = people.get(username);
    if (!entry) people.set(username, (entry = { username, timeline: [], runs: [] }));
    return entry;
  };
  const postOfComment = new Map<string, string>();

  for (const e of events.rows) {
    const at = e.received_at.toISOString();
    const { comment, message } = e.payload;
    if (e.kind === "comment" && comment) {
      postOfComment.set(comment.id, comment.postId);
      person(e.payload.from.id).timeline.push({
        kind: "comment",
        id: e.id,
        at,
        text: comment.text,
        postId: comment.postId,
        commentId: comment.id,
      });
    } else if (message) {
      person(e.payload.from.id).timeline.push({
        kind: "dm_in",
        id: e.id,
        at,
        text: message.text,
        attachments: message.attachments.map((a) => a.type),
        runId: e.run_id,
        consumed: e.consumed_at !== null,
      });
    }
  }

  for (const a of actions.rows) {
    const commentId = a.request.commentId ?? null;
    person(a.contact_id).timeline.push({
      kind: a.kind === "dm" ? "dm_out" : "comment_reply",
      id: a.id,
      at: a.created_at.toISOString(),
      text: a.request.text,
      runId: a.run_id,
      stepIndex: a.step_index,
      status: a.status,
      attempts: a.attempts,
      attemptLog: a.attempt_log,
      lastError: a.last_error,
      commentId,
      mode: a.kind === "dm" ? (commentId ? "private_reply" : "recipient_id") : null,
    });
  }

  for (const r of runs.rows) {
    person(r.username).runs.push({
      ...r,
      postId: postOfComment.get(r.triggerCommentId) ?? null,
      waitDeadline: r.waitDeadline?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    });
  }

  for (const p of people.values()) {
    p.timeline.sort((x, y) => x.at.localeCompare(y.at));
    p.runs.reverse();
  }

  const current = automation.rows[0]!;
  return {
    serverTime: current.now.toISOString(),
    automation: { id: sandbox.automationId, version: current.version, form: formFromDefinition(current.definition) },
    people: [...people.values()],
  };
}

/** Removes sandboxes created more than SANDBOX_TTL ago, with everything their runs produced. */
export async function deleteExpiredSandboxes(pool: Db): Promise<number> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; external_account_id: string }>(
      `select id, external_account_id from social_accounts
       where platform = $1 and external_account_id like 'demo-%' and created_at < now() - $2::interval
       for update`,
      [DEMO_PLATFORM, SANDBOX_TTL],
    );
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    const external = rows.map((r) => r.external_account_id);
    const runs = "select id from runs where account_id = any($1)";
    await client.query(`select graphile_worker.remove_job('run:' || id || ':timeout') from (${runs}) r`, [ids]);
    await client.query(`delete from outbound_actions where run_id in (${runs})`, [ids]);
    await client.query(`delete from run_inputs where run_id in (${runs})`, [ids]);
    await client.query("delete from runs where account_id = any($1)", [ids]);
    await client.query(
      "delete from automation_versions where automation_id in (select id from automations where account_id = any($1))",
      [ids],
    );
    await client.query("delete from automations where account_id = any($1)", [ids]);
    await client.query("delete from inbound_events where platform = $1 and payload->>'accountId' = any($2)", [
      DEMO_PLATFORM,
      external,
    ]);
    await client.query("delete from social_accounts where id = any($1)", [ids]);
    return ids.length;
  });
}
