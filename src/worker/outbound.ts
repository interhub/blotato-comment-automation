import type { RetryPolicy } from "../config.js";
import { PlatformError } from "../platform/types.js";
import type { WorkerDeps } from "./deps.js";
import type { Run } from "./runs.js";

export type SendOutcome =
  | { type: "sent" }
  | { type: "retry"; error: string; delayMs: number }
  | { type: "fail"; error: string };

export interface OutboundMessage {
  kind: "comment_reply" | "dm";
  stepIndex: number;
  /** Numbers the messages of one step (prompt, reprompts, sign-off); part of the idempotency key. */
  seq: number;
  text: string;
}

interface StoredAction {
  status: string;
  attempts: number;
  last_error: string | null;
  request: { commentId?: string };
}

export function retryDelayMs(policy: RetryPolicy, attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const exponential = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + 0.5 * Math.random()));
}

/**
 * Sends at most once per idempotency key from our side: the action row is written before the
 * call, and once `sent` is recorded the message is never sent again. A crash after the provider
 * accepted but before we recorded `sent` resends it on retry; only a provider that honours the
 * idempotency key absorbs that duplicate, and Instagram does not.
 *
 * The run's first DM goes out as a private reply to the trigger comment, the only opener Instagram
 * allows. That choice is stored in the action's request, so a retry sends it the same way.
 */
export async function sendOnce(deps: WorkerDeps, run: Run, message: OutboundMessage): Promise<SendOutcome> {
  const { pool } = deps;
  const key = `${run.id}:${message.stepIndex}:${message.seq}`;
  const request =
    message.kind === "dm"
      ? { recipientId: run.contactId, text: message.text }
      : { commentId: run.triggerCommentId, text: message.text };

  await pool.query(
    `insert into outbound_actions (run_id, step_index, idempotency_key, kind, request)
     select $1, $2, $3, $4::text,
            case when $4::text = 'dm' and not exists (select 1 from outbound_actions where run_id = $1 and kind = 'dm')
                 then $5::jsonb || jsonb_build_object('commentId', $6::text)
                 else $5::jsonb end
     on conflict (idempotency_key) do nothing`,
    [run.id, message.stepIndex, key, message.kind, request, run.triggerCommentId],
  );
  const { rows } = await pool.query<StoredAction>(
    "select status, attempts, last_error, request from outbound_actions where idempotency_key = $1",
    [key],
  );
  const action = rows[0]!;
  if (action.status === "sent") return { type: "sent" };
  if (action.status === "failed") return { type: "fail", error: action.last_error ?? "send failed" };

  const platform = deps.platforms[run.platform];
  if (!platform) throw new Error(`no platform adapter for ${run.platform}`);

  try {
    const result =
      message.kind === "dm"
        ? await platform.sendDirectMessage({
            accountId: run.externalAccountId,
            recipientId: run.contactId,
            commentId: action.request.commentId,
            text: message.text,
            idempotencyKey: key,
          })
        : await platform.replyToComment({
            accountId: run.externalAccountId,
            commentId: run.triggerCommentId,
            text: message.text,
            idempotencyKey: key,
          });
    await pool.query(
      `update outbound_actions
       set status = 'sent', attempts = attempts + 1, provider_message_id = $2, last_error = null, updated_at = now()
       where idempotency_key = $1`,
      [key, result.messageId],
    );
    return { type: "sent" };
  } catch (error) {
    // Anything that is not a classified platform error is a bug: let graphile-worker's job retry handle it.
    if (!(error instanceof PlatformError)) throw error;

    const attempt = action.attempts + 1;
    const giveUp = error.kind === "permanent" || attempt >= deps.retry.maxAttempts;
    const delayMs = giveUp ? null : retryDelayMs(deps.retry, attempt, error.retryAfterMs);
    const description = `${message.kind} ${error.kind} error on attempt ${attempt}: ${error.message}`;
    await pool.query(
      `update outbound_actions
       set attempts = $2, status = $3, last_error = $4, updated_at = now(),
           attempt_log = attempt_log || jsonb_build_array(jsonb_build_object(
             'attempt', $2::int, 'at', now(), 'error', $4::text, 'kind', $5::text, 'retryInMs', $6::int))
       where idempotency_key = $1`,
      [key, attempt, giveUp ? "failed" : "pending", description, error.kind, delayMs],
    );
    return delayMs === null ? { type: "fail", error: description } : { type: "retry", error: description, delayMs };
  }
}
