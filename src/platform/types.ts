export const PLATFORMS = ["instagram", "facebook"] as const;
export type PlatformName = (typeof PLATFORMS)[number];

export interface SendResult {
  messageId: string;
}

export interface CommentReply {
  accountId: string;
  commentId: string;
  text: string;
  idempotencyKey: string;
}

/**
 * Instagram lets a business message only people who wrote to it first. A private reply to their
 * comment is the allowed opener, so when commentId is set the adapter sends to that comment instead
 * of to recipientId.
 */
export interface DirectMessage {
  accountId: string;
  recipientId: string;
  commentId?: string;
  text: string;
  idempotencyKey: string;
}

/** How long after a comment Instagram still accepts a private reply to it (a Postgres interval). */
export const PRIVATE_REPLY_WINDOW = "7 days";

/** The only surface the worker sees. Adapters translate provider errors into PlatformError. */
export interface SocialPlatform {
  replyToComment(input: CommentReply): Promise<SendResult>;
  sendDirectMessage(input: DirectMessage): Promise<SendResult>;
}

/**
 * transient: timeouts, 5xx, 429 (retried with backoff, retryAfterMs wins over the formula).
 * permanent: blocked by the user, messaging window closed, invalid token (never retried).
 */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly kind: "transient" | "permanent",
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}
