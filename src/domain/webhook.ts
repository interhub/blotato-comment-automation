import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Normalized webhook shape. Real adapters map Instagram/Facebook payloads onto it;
 * the prototype receives it directly.
 *
 * comment: { eventId, type: "comment", accountId, comment: { id, postId, text }, from: { id, username } }
 * message: { eventId, type: "message", accountId, message: { id, text, attachments }, from: { id, username } }
 *
 * accountId is the platform id of the connected business account; from.id is the person.
 */
const from = z.object({ id: z.string().min(1), username: z.string().default("") });

export const webhookPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    eventId: z.string().min(1),
    type: z.literal("comment"),
    accountId: z.string().min(1),
    from,
    comment: z.object({ id: z.string().min(1), postId: z.string().min(1), text: z.string() }),
  }),
  z.object({
    eventId: z.string().min(1),
    type: z.literal("message"),
    accountId: z.string().min(1),
    from,
    message: z.object({
      id: z.string().min(1),
      text: z.string().default(""),
      attachments: z.array(z.object({ type: z.string() })).default([]),
    }),
  }),
]);

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
export type CommentPayload = Extract<WebhookPayload, { type: "comment" }>;
export type MessagePayload = Extract<WebhookPayload, { type: "message" }>;

export const SIGNATURE_HEADER = "x-hub-signature-256";

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(body: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(signBody(body, secret));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
