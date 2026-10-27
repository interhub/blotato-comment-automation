# Comment-triggered DM automations

A backend prototype for automations like "when someone comments *pricing*, reply to the comment, DM them for their email, wait for a valid answer, then DM a link". Fastify API, a graphile-worker worker and Postgres as the only moving parts.

The reasoning (architecture, data model, execution model, reliability, rejected alternatives) is in [DESIGN.md](DESIGN.md). This README covers running the code.

## Quick start

Requires Node 22+ and Docker.

```bash
docker compose up -d --wait   # Postgres 16 on localhost:54329
npm install
npm test                      # creates and migrates the test database itself
```

`npm run typecheck` runs `tsc --noEmit`.

## Running the API and the worker

```bash
cp .env.example .env          # optional, defaults match docker-compose.yml
npm run migrate
npm run dev                   # API on :3000 and the worker in one process
```

In production these are two processes over one database: `npm run start:api` and `npm run start:worker`. The worker uses `MockPlatform` adapters that log every message they "send" instead of calling Instagram. It also runs an hourly `gc_job_queues` cron task that deletes graphile-worker queue rows of finished runs (every run has its own named queue, and graphile-worker does not remove them by itself).

Create an automation:

```bash
curl -s -X POST localhost:3000/automations -H 'content-type: application/json' -d '{
  "platform": "instagram",
  "accountId": "demo-account",
  "name": "Pricing DM",
  "definition": {
    "trigger": { "type": "comment_keyword", "keywords": ["pricing"] },
    "steps": [
      { "type": "reply_to_comment", "text": "Sent you a DM!" },
      { "type": "collect_input", "prompt": "Hey {{username}}! What is the best email to send the pricing to?",
        "saveAs": "email", "timeoutSeconds": 86400, "maxReprompts": 3 },
      { "type": "send_dm", "text": "Here you go: https://example.com/pricing?e={{email|url}}" }
    ]
  }
}'
```

Templates insert `{{name}}` as is; `{{name|url}}` URL-encodes the value, so `jo+promo@gmail.com` reaches the landing page intact. The first DM of a run goes out as a private reply to the trigger comment (Instagram's only allowed opener), later DMs go to the person's id. A queued run whose comment is older than the 7-day private reply window (`PRIVATE_REPLY_WINDOW` in `src/platform/types.ts`) ends as `failed` with outcome `expired` without sending anything, and the person's next queued run starts.

Send signed webhooks as a commenter (`scripts/send-webhook.ts` builds the normalized payload and the `x-hub-signature-256` HMAC):

```bash
npm run webhook -- comment ana "Pricing please!"
npm run webhook -- message ana "how much is it?"   # friendly nudge back
npm run webhook -- message ana "ana@example.io"    # link goes out
```

Or sign by hand:

```bash
BODY='{"eventId":"evt-1","type":"comment","accountId":"demo-account","from":{"id":"ana","username":"ana"},"comment":{"id":"c-1","postId":"p-1","text":"pricing"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac dev-webhook-secret | sed 's/^.* //')"
curl -s -X POST localhost:3000/webhooks/instagram -H 'content-type: application/json' -H "x-hub-signature-256: $SIG" -d "$BODY"
```

Then inspect what happened:

```bash
curl -s localhost:3000/automations/<automationId>   # definition, version, recent runs
curl -s localhost:3000/runs/<runId>                 # run state, inputs, every outbound action with attempts and errors
```

`PUT /automations/:id` with `{ "definition": ... }` stores a new version; runs already in flight keep the version they started with.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://app:app@localhost:54329/comment_automation` | main database |
| `TEST_DATABASE_URL` | `.../comment_automation_test` | used by `npm test` |
| `PORT`, `HOST` | `3000`, `127.0.0.1` | API listen address |
| `WEBHOOK_SECRET` | `dev-webhook-secret`; required when `NODE_ENV=production` | HMAC secret for webhook signatures |
| `WORKER_CONCURRENCY` | `5` | jobs executed in parallel |
| `RETRY_BASE_MS`, `RETRY_CAP_MS`, `RETRY_MAX_ATTEMPTS` | `1000`, `60000`, `5` | backoff for transient platform errors |
| `ADVANCE_RUN_MAX_ATTEMPTS` | `5` | attempts of an `advance_run` job that crashes with a non-platform error (a bug, a database error) before its run is closed as `failed` and the person's next queued run starts |

The wait timeout is per step (`timeoutSeconds`, fractions allowed), default 24 hours to match Instagram's messaging window.

## Tests

Integration tests drive the real webhook endpoint (`fastify.inject`) and the real worker task list against Postgres, and assert both the database state and what `MockPlatform` actually delivered. `drain()` in `test/harness.ts` runs `graphile-worker`'s `runOnce` with 4 concurrent workers until no job is due, sleeping only until the next scheduled job (retry backoff, short timeouts), and fails the test if any task threw.

| File | Covers |
|---|---|
| `happy-path.test.ts` | comment, ask, email, link; first DM as a private reply and later DMs by id; URL-encoded `jo+promo@gmail.com`; keyword misses and the account's own comments |
| `duplicates.test.ts` | the same webhook 3x in parallel, a comment re-sent under a new event id, a DM delivered twice |
| `retries.test.ts` | transient failures with growing backoff, `Retry-After`, permanent failure, exhausted retries, `last_error` cleared after a later successful send, a job that keeps crashing with a non-platform error fails its run and starts the next queued one |
| `timeouts.test.ts` | timeout, late reply ignored, reply that arrives before the run is marked waiting, a reply and the timeout at the same deadline run concurrently (exactly one outcome wins) |
| `concurrency.test.ts` | two people at once, one person on two posts at once (second run queued), the queued run starts after the first ends as `completed`, `timed_out`, `failed`, `declined` or `gave_up`, an expired queued run is closed without sending |
| `replies.test.ts` | question, emoji, attachment, typo, refusal, reprompt budget, copy rotation and overrides, two questions in a row where an extra message sent with the first answer does not leak into the second |
| `idempotency.test.ts` | steps already recorded as `sent` are not sent again; a lost `sent` write leads to a second call that only a provider honouring the idempotency key (the mock, not Instagram) drops |
| `maintenance.test.ts` | `gc_job_queues` drops the queues of finished runs and keeps live ones |
| `api.test.ts` | signatures (including a forged one of the right length), validation, versioning, 404s |
| `unit/*` | keyword matching, reply classifier (whole-message refusals), template `url` filter, backoff, HMAC, `WEBHOOK_SECRET` in production |

## Layout

```
migrations/001_init.sql     schema from DESIGN.md section 5
scripts/send-webhook.ts     sign and send a mock webhook to a running API
src/
  main.ts                   entrypoint: api | worker | all
  config.ts  db.ts  jobs.ts  logger.ts  migrate.ts
  api/                      Fastify app: webhooks, automations, runs, health
  domain/                   definition schema, keyword match, reply classifier, copy, webhook payload + HMAC
  platform/                 SocialPlatform interface, PlatformError, MockPlatform
  worker/                   process_event, advance_run, wait_timeout, gc_job_queues, steps, run inputs, idempotent outbound sends
test/                       harness, integration tests, unit tests
```

## AI usage

- **Design decisions: me (roughly 20% of the work).** Before any code was written, the problem was broken into seven design forks, each with two or three options and their trade-offs. AI prepared the options; I made each choice:
  - job queue inside Postgres through an existing library (graphile-worker), not Redis/BullMQ or a hand-written jobs table;
  - automations as a linear list of typed, versioned steps, not a branching graph and not one hard-coded flow;
  - waiting for the human as a persisted state plus a timer job, not a polling sweeper and not Temporal;
  - an inbound event log with a unique key to absorb duplicate webhooks;
  - one run per comment plus a deterministic idempotency key per outbound message;
  - a person's second conversation is queued behind the first, not run in parallel;
  - a non-email reply gets a friendly reprompt that fits what the person actually sent (question, emoji, typo, refusal), with a budget, instead of silence or an immediate stop.
- **Implementation, tests and documentation: AI agents (Claude Code) under my direction.** They wrote the code, the test suite, DESIGN.md and this README from those decisions, plus a separate AI review pass for race conditions and idempotency gaps. I reviewed the outcome against my decisions; nothing was submitted with failing tests.
