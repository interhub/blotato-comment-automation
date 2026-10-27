# Comment-triggered DM automations: design

## 1. Problem

A customer connects a social account and creates an automation such as:

> When someone comments "pricing" on any of my Instagram posts:
> 1. reply to the comment with "Sent you a DM!",
> 2. DM the commenter asking for their email,
> 3. wait for the reply,
> 4. once a valid email arrives, DM them a link.

The platform already receives comments and DMs (webhooks) and can reply to comments and send DMs. This document covers the backend that turns those primitives into reliable, long-running, per-person conversations.

The hard parts are not the four steps. They are:

- webhooks arrive late, twice, or out of order;
- a run lives for hours or days while it waits for a human;
- outbound calls fail, get rate-limited, or succeed right before our process dies;
- the same person can trigger several automations at once, and one DM reply must land in exactly one place;
- humans do not answer the question they were asked.

## 2. Scope and assumptions

- Stack: TypeScript, Fastify, Postgres. No Redis, no separate workflow cluster: everything durable lives in Postgres, which fits a Heroku-style deployment (web dyno + worker dyno + one database).
- Platform APIs sit behind a `SocialPlatform` interface. The prototype ships a mock implementation that can be told to fail.
- Instagram constraints that shape the defaults: a business account may DM a user only within 24 hours of that user's last message to it, and a private reply to a comment counts as the opening message. The default wait timeout is therefore 24 hours.
- Out of scope: auth/multi-tenant admin UI, OAuth token refresh, per-account rate-limit budgets, analytics. Section 9 lists what a production version adds.

## 3. Architecture

```
 Instagram / FB / ... webhooks
            |
            v
 +---------------------+   one transaction    +--------------------------+
 | Fastify API         | -------------------> | inbound_events (UNIQUE)  |
 | POST /webhooks/:p   |   insert + add_job   | graphile_worker.jobs     |
 | (verify, store, 200)|                      +--------------------------+
 +---------------------+                                   |
                                                           v
 +--------------------------------------------------------------------+
 | Worker (graphile-worker, same Postgres)                            |
 |                                                                    |
 |  process_event  -> match automations, create runs, route DM replies|
 |  advance_run    -> execute the next step(s) of one run             |
 |  wait_timeout   -> close a run that waited too long                |
 +--------------------------------------------------------------------+
            |
            v
   SocialPlatform interface  ->  real API client  |  MockPlatform (tests)
```

Two processes, one database:

- **API** does as little as possible on the request path: verify the signature, insert the raw event into `inbound_events` (deduplicated by a unique key), enqueue a `process_event` job in the same transaction, return `200`. Platforms retry webhooks that are slow, so the webhook handler never calls a platform API.
- **Worker** runs [graphile-worker](https://github.com/graphile/worker). Jobs are rows in Postgres, picked with `FOR UPDATE SKIP LOCKED`, woken via `LISTEN/NOTIFY`. The key property for this design: a job can be added from SQL (`graphile_worker.add_job(...)`) inside the same transaction as our own state change. State and the work that follows from it commit together or not at all, so there is no "state saved, job lost" window and no outbox table to maintain.

## 4. Automation model

An automation is a **trigger plus an ordered list of typed steps**, stored as versioned JSON data rather than code.

```jsonc
{
  "trigger": {
    "type": "comment_keyword",
    "keywords": ["pricing"],         // case-insensitive, whole word
    "postIds": null                  // null = any post
  },
  "steps": [
    { "type": "reply_to_comment", "text": "Sent you a DM!" },
    {
      "type": "collect_input",
      "prompt": "Hey! What's the best email to send the pricing to?",
      "validate": "email",
      "saveAs": "email",
      "timeoutSeconds": 86400,
      "maxReprompts": 3
    },
    { "type": "send_dm", "text": "Here you go: https://example.com/pricing?e={{email|url}}" }
  ]
}
```

Decisions:

- **Linear steps, not a graph.** The requested flow and the common variants ("ask for a phone number", "ask two questions then send a link", "reply only") are sequences. A branching graph editor multiplies validation, execution and testing work for a feature nobody asked for yet. Adding a step type is one file implementing `execute(run, ctx)`; adding branches later means turning `steps[]` into nodes with `next` pointers, which the run model below already tolerates (a run stores "current step id", not "the rest of the program").
- **Ask and wait are one step (`collect_input`).** The brief lists them as steps 2 and 3, but splitting them creates a real race: the question DM is sent, and the human answers before the worker has committed "now waiting". That answer would arrive at a run that is not listening and get dropped. A single step opens its input window (in the database) before it sends the question, so any reply that arrives afterwards is captured. It is also the reusable primitive customers think in: "ask X, wait for a valid answer".
- **Versioned definitions.** Editing an automation inserts a new row in `automation_versions`. A run is pinned to the version it started with, so a run waiting for an email never sees its steps renumbered under it.
- **Validated on write.** Definitions are checked with a schema (zod) when saved, so the worker never meets an unknown step type at 3 a.m.
- **Templates** use `{{var}}` placeholders filled from the run context (`email`, `username`); `{{var|url}}` URL-encodes the value for use inside a link (`jo+promo@x.io` stays intact).

## 5. Data model

```sql
social_accounts      (id, platform, external_account_id, UNIQUE(platform, external_account_id))

automations          (id, account_id, name, status: active|paused, current_version)
automation_versions  (automation_id, version, definition jsonb, created_at,
                      PRIMARY KEY (automation_id, version))

inbound_events       (id, platform, external_event_id, kind: comment|message,
                      payload jsonb, received_at, processed_at,
                      UNIQUE (platform, external_event_id))

runs                 (id, automation_id, automation_version, account_id,
                      contact_id,                 -- platform user id of the commenter
                      trigger_comment_id,
                      status: queued|running|waiting|completed|failed|timed_out,
                      outcome text,               -- e.g. email_collected, declined, gave_up, expired
                      current_step int,
                      context jsonb,              -- collected vars, reprompt counter
                      input_opened_at, wait_deadline,
                      last_error, created_at, updated_at,
                      UNIQUE (automation_id, trigger_comment_id))
  -- at most one live conversation per person per account
  UNIQUE INDEX one_active_run_per_contact ON runs (account_id, contact_id)
    WHERE status IN ('running', 'waiting')

run_inputs           (id, run_id, inbound_event_id UNIQUE, text,
                      attachments,                -- sticker / image-only replies
                      received_at, consumed_at)

outbound_actions     (id, run_id, step_index, idempotency_key UNIQUE,
                      kind: comment_reply|dm, request jsonb,
                      status: pending|sent|failed, attempts,
                      attempt_log jsonb,          -- per attempt: error, chosen delay

                      provider_message_id, last_error, created_at, updated_at)
```

Why each constraint exists:

| Constraint | Guards against |
|---|---|
| `inbound_events UNIQUE(platform, external_event_id)` | the same webhook delivered twice |
| `runs UNIQUE(automation_id, trigger_comment_id)` | one comment starting the same automation twice (e.g. via a re-sent event with a new event id) |
| `one_active_run_per_contact` (partial unique) | two live conversations with one person; makes DM routing unambiguous |
| `run_inputs UNIQUE(inbound_event_id)` | one DM being consumed twice as an answer |
| `outbound_actions UNIQUE(idempotency_key)` | sending the same message twice on retry |

## 6. Execution model

### 6.1 Ingest

`POST /webhooks/:platform`

1. Verify the HMAC signature header. Reject on mismatch.
2. In one transaction: `INSERT INTO inbound_events ... ON CONFLICT DO NOTHING RETURNING id`. If a row came back, `add_job('process_event', {eventId}, job_key = 'event:<id>')`.
3. Return `200` either way. A duplicate is acknowledged so the platform stops retrying.

### 6.2 `process_event`

**Comment event.** Load active automations of the account and match the trigger (keyword as a whole word, case-insensitive; optional post filter). Comments written by the account itself are ignored, so our own "Sent you a DM!" can never trigger a loop. For each match, in one transaction:

1. `pg_advisory_xact_lock(hash(account_id, contact_id))` to serialize decisions about this person.
2. Insert the run `ON CONFLICT (automation_id, trigger_comment_id) DO NOTHING`.
3. If the person has no active run, the new run starts as `running` and an `advance_run` job is added. Otherwise it is inserted as `queued` and waits its turn (6.5).

The advisory lock makes the check-then-insert safe; the partial unique index is the backstop if the lock is ever forgotten.

**Message event (a DM from a person).** In one transaction, take the same per-person advisory lock and load the person's active run. If it has an open input window (`input_opened_at IS NOT NULL` and the message arrived after it), insert into `run_inputs` and, if the run is `waiting`, flip it to `running` and add `advance_run`. If the run is still `running` (the question is being sent right now), the input is simply stored; the step picks it up when it reaches its wait point. With no active run, the DM is recorded and ignored.

### 6.3 `advance_run`

All jobs for one run use the graphile-worker queue `run:<id>`. Jobs in a named queue execute one at a time, so two workers never execute the same run concurrently, without holding a database lock across a network call.

The loop:

1. Load the run and its pinned definition. If it is not `running`, exit (stale job).
2. Execute `steps[current_step]`. A step returns one of:
   - `next` - advance `current_step`, persist context, continue the loop;
   - `wait(deadline)` - set `status = waiting`, `wait_deadline`, add `wait_timeout` with `run_at = deadline`, exit;
   - `done(outcome)` - finish the run;
   - `retry(error)` / `fail(error)` - see section 7.
3. After the last step, the run is `completed`.

Each state transition is one short transaction. Platform calls happen between transactions, never inside one.

### 6.4 Waiting for the human: `collect_input`

1. **Open the window.** If the step is entered for the first time, set `input_opened_at = now()` under the per-person lock (committed) and only then send the prompt DM. Replies are captured from this moment on, including ones that beat the "waiting" status. The first DM of a run is sent as a private reply to the trigger comment: Instagram does not allow messaging someone who never wrote to the account, and a private reply is the sanctioned way to open that conversation. Later DMs go to the person's id, inside the 24h window their own reply opened.
2. **Consume input.** Take the oldest unconsumed `run_inputs` row received after the window opened. When the step finishes, any other unconsumed inputs are marked consumed, so a trailing "thanks!" is never read as the answer to the next question. Classify the reply:

   | Reply | Reaction |
   |---|---|
   | contains a valid email (also inside text: "sure, it's jo@x.io!") | save `email`, step returns `next` |
   | looks like an email with a typo (`jo@gmail`, `jo at gmail dot com`) | "so close! looks like a typo, double-check it?" |
   | a question ("how much is it?") | "good q! the link has every answer, just drop your email" |
   | emoji, sticker or attachment only | "love the vibe 😄 but I need an email to send it" |
   | a clear no ("no", "stop", "not interested") | polite exit: "no worries! comment again anytime ✌️", outcome `declined` |
   | anything else | "hmm, that doesn't look like an email. try again?" |

   Each category has several phrasings, rotated by the reprompt counter so a person never gets the same line twice in a row. Customers can override the copy per automation.
3. **Reprompt budget.** The first `maxReprompts` (default 3) non-email replies get a reprompt; the next one gets a short sign-off and the run ends with outcome `gave_up`. It keeps the conversation human without nagging forever.
4. **Nothing to consume** - return `wait(deadline)`. A fresh user message re-opens Instagram's 24h window, so each reprompt moves the deadline to `now + timeoutSeconds`.

### 6.5 Timeouts and the race with a late reply

`wait_timeout(runId, stepIndex)` takes the per-person advisory lock and closes the run as `timed_out` only if it is still `waiting` on the same step, the deadline has passed, and no unconsumed input exists. DM routing takes the same lock, so a reply and a timeout that arrive in the same instant serialize: whichever commits first wins, and the other sees a changed state and does nothing. Every code path takes this lock before touching run rows, in the same order, so the two cannot deadlock. A reply that arrives after the timeout finds no active run and is ignored.

### 6.6 One conversation per person, others queued

When a person triggers a second automation (or the same one on another post) while a conversation is live, the new run is `queued`. Whenever a run reaches a final state, the same transaction promotes that person's oldest queued run to `running` and adds its `advance_run` job. The partial unique index guarantees there is never more than one live run, so a DM reply always has exactly one owner. Different people never block each other. A private reply is only allowed within 7 days of the comment (measured from when its webhook arrived), so a run that waited in the queue longer than that is closed as `failed` with outcome `expired` and the next one is promoted.

## 7. Reliability

**Delivery guarantee: at-least-once execution, effectively-once side effects.** Exactly-once delivery across a network boundary is not available; we make every repeated action harmless instead.

- **Duplicate webhooks** stop at the `inbound_events` unique key (and, for a re-sent comment with a different event id, at the run's unique key).
- **Idempotent outbound calls.** Every platform call carries a deterministic key: `<runId>:<stepIndex>:<n>` (n distinguishes the prompt from reprompts). Before calling, the worker inserts an `outbound_actions` row; if a row with this key is already `sent`, the call is skipped and the stored result is reused. The mock platform also honours the key, as Stripe-style APIs do.
- **The unavoidable crash window.** If the process dies after the platform accepted a message but before we stored `sent`, the retry will send again unless the provider deduplicates by key. Instagram's Send API has no idempotency key, so in production this window is narrowed (store `pending` before the call, check the conversation for a message with our marker before re-sending a `pending` action older than N seconds). It is documented, not hidden.
- **Retries with backoff.** Platform errors are classified by the adapter:
  - *transient* (timeouts, 5xx, 429): record the attempt, re-enqueue `advance_run` with `run_at = now + min(cap, base * 2^(attempt-1)) * jitter(0.5..1)`; a `Retry-After` hint wins over the formula. After `maxAttempts` (default 5) the run becomes `failed` with `last_error`.
  - *permanent* (user blocked the account, messaging window closed, invalid token): no retry, run `failed` immediately.
  These are domain retries with our own policy and full history in `outbound_actions`. graphile-worker's built-in job retry stays underneath as a safety net for crashes and bugs, with a small attempt budget per run step (`ADVANCE_RUN_MAX_ATTEMPTS`, default 5): once it is spent, an unexpected error closes the run as `failed` instead of leaving it `running`, so the person's queued runs are promoted and their next DM is not routed to a dead run.
- **Queue housekeeping.** Each run gets its own named queue (section 6.3); an hourly cron task runs graphile-worker's `GC_JOB_QUEUES` cleanup so empty queue rows do not accumulate.
- **Stale jobs are harmless.** Every handler re-reads state under a lock and no-ops if the world moved on (run finished, step changed, timeout already handled).
- **Observability.** `GET /runs/:id` returns the run, its inputs and every outbound action with attempts and errors, which is the first thing support needs ("why didn't this person get the link?"). Logs are structured (pino) with `runId`, `automationId`, `eventId`.

## 8. Concurrency summary

| Situation | Mechanism |
|---|---|
| Same webhook delivered 3 times in parallel | `inbound_events` unique key; only one insert returns a row |
| Two different people comment at once | independent runs, independent job queues, run in parallel |
| Same person comments on two posts at once | advisory lock per person + partial unique index; second run `queued` |
| Two `advance_run` jobs for one run | per-run named queue: executed one after another, second sees state and no-ops |
| Reply arrives while the question is still being sent | input window opened before the send; reply stored in `run_inputs` |
| Reply and timeout at the same moment | per-person advisory lock; first commit wins |
| Same DM delivered twice | `inbound_events` key, then `run_inputs` key |

## 9. Rejected alternatives

| Option | Why not (for this system, now) |
|---|---|
| Redis + BullMQ | Extra service to run and pay for; enqueue cannot share a transaction with Postgres state, which reopens the lost-job and double-job windows. Throughput is not the bottleneck here; platform rate limits are. |
| Hand-written jobs table | Would show the `SKIP LOCKED` mechanics, but retries, scheduling, named queues and `LISTEN/NOTIFY` wake-ups are solved problems; graphile-worker gives them with transactional SQL enqueue. |
| Temporal / durable workflow engine | Excellent fit for "wait for signal or 24h", but a separate cluster and a new programming model for a team on Heroku. The run table plus timers covers the need with one database. |
| Polling sweeper for waits | Simple, but adds up to a poll interval of latency to every reply and turns into a large periodic scan with many tenants. |
| Branching graph DSL | More power than the use case needs; most of the cost lands in validation, editor UX and testing. Linear steps leave room to add branches later. |
| Hard-coded single flow | The brief asks for customer-created automations. |
| In-memory / Redis TTL dedup | Lost on restart, not transactional with the event insert, leaves no audit trail. |
| Mark "sent" before calling the API | Prevents duplicates by losing messages on crash. A lost link is worse than a rare duplicate. |
| Parallel runs per person, reply goes to the newest | Two identical email questions in one inbox, and the older run hangs until timeout. Looks like a bug to the customer. |
| Ignore or end on a non-email reply | Loses leads on a typo, or leaves the person confused. |

## 10. What production adds

- Per-account rate-limit budgets (token bucket in Postgres) shared by all runs of an account.
- Contact profiles: remember a collected email so a queued second run can skip the question.
- Branching steps (`if reply matches X`), more triggers (story replies, DM keywords), A/B copy.
- Retention jobs for `inbound_events` and finished runs; partitioning by month if volumes demand it.
- Metrics: runs by status, time-to-reply, reprompt rate, failure reasons per platform error code; alerts on rising `failed`.
- Admin endpoints to retry a failed run from its current step.
