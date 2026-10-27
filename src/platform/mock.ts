import { randomUUID } from "node:crypto";
import { PlatformError, type CommentReply, type DirectMessage, type SendResult, type SocialPlatform } from "./types.js";

export type DmMode = "private_reply" | "recipient_id";

export type MockCall =
  | ({ kind: "comment_reply"; at: number } & CommentReply)
  | ({ kind: "dm"; at: number; mode: DmMode } & DirectMessage);

export type SentMessage = MockCall & { messageId: string };

interface FailureScript {
  remaining: number;
  error: PlatformError;
  when: (call: MockCall) => boolean;
}

/**
 * In-memory platform: records what was delivered and whether a DM went as a private reply,
 * honours idempotency keys the way Stripe-style APIs do, and can be scripted to fail.
 */
export class MockPlatform implements SocialPlatform {
  /** Every call that reached the platform, including failed and deduplicated ones. */
  readonly calls: MockCall[] = [];
  /** Messages that were actually delivered to a person. */
  readonly sent: SentMessage[] = [];
  /** Test hook that runs inside the "network call", before the message is accepted. */
  onCall?: (call: MockCall) => Promise<void> | void;
  private readonly byKey = new Map<string, SendResult>();
  private scripts: FailureScript[] = [];

  fail(options: {
    kind: "transient" | "permanent";
    times?: number;
    retryAfterMs?: number;
    when?: (call: MockCall) => boolean;
  }): void {
    this.scripts.push({
      remaining: options.times ?? 1,
      error: new PlatformError(`mock ${options.kind} failure`, options.kind, options.retryAfterMs),
      when: options.when ?? (() => true),
    });
  }

  reset(): void {
    this.calls.length = 0;
    this.sent.length = 0;
    this.byKey.clear();
    this.scripts = [];
    this.onCall = undefined;
  }

  dmsTo(recipientId: string): string[] {
    return this.sent.filter((m) => m.kind === "dm" && m.recipientId === recipientId).map((m) => m.text);
  }

  replyToComment(input: CommentReply): Promise<SendResult> {
    return this.deliver({ kind: "comment_reply", at: Date.now(), ...input });
  }

  sendDirectMessage(input: DirectMessage): Promise<SendResult> {
    const mode: DmMode = input.commentId === undefined ? "recipient_id" : "private_reply";
    return this.deliver({ kind: "dm", at: Date.now(), mode, ...input });
  }

  private async deliver(call: MockCall): Promise<SendResult> {
    this.calls.push(call);
    const previous = this.byKey.get(call.idempotencyKey);
    if (previous) return previous;

    await this.onCall?.(call);

    const script = this.scripts.find((s) => s.remaining > 0 && s.when(call));
    if (script) {
      script.remaining -= 1;
      throw script.error;
    }

    const result = { messageId: randomUUID() };
    this.byKey.set(call.idempotencyKey, result);
    this.sent.push({ ...call, ...result });
    return result;
  }
}
