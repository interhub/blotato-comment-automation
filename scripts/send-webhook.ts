import { randomUUID } from "node:crypto";
import { SIGNATURE_HEADER, signBody } from "../src/domain/webhook.js";

const usage = `usage:
  npm run webhook -- comment <user> "<text>" [postId]
  npm run webhook -- message <user> "<text>"`;

const [type, user, text = "", postId = "post-1"] = process.argv.slice(2);
if ((type !== "comment" && type !== "message") || !user) {
  console.error(usage);
  process.exit(1);
}

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3000";
const accountId = process.env.ACCOUNT_ID ?? "demo-account";
const secret = process.env.WEBHOOK_SECRET ?? "dev-webhook-secret";
const id = randomUUID();

const payload =
  type === "comment"
    ? { eventId: `evt-${id}`, type, accountId, from: { id: user, username: user }, comment: { id, postId, text } }
    : { eventId: `evt-${id}`, type, accountId, from: { id: user, username: user }, message: { id, text, attachments: [] } };

const body = JSON.stringify(payload);
const res = await fetch(`${apiUrl}/webhooks/instagram`, {
  method: "POST",
  headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(body, secret) },
  body,
});
console.log(res.status, await res.text());
