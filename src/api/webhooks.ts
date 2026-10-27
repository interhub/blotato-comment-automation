import type { FastifyInstance } from "fastify";
import { withTransaction, type Db } from "../db.js";
import { addJob } from "../jobs.js";
import { PLATFORMS } from "../platform/types.js";
import { SIGNATURE_HEADER, verifySignature, webhookPayloadSchema } from "../domain/webhook.js";
import { HttpError, parseOr400 } from "./http.js";

/**
 * Verify, store, enqueue, acknowledge. Platforms retry slow webhooks, so nothing here
 * calls a platform API or runs automation logic.
 */
export async function webhookRoutes(app: FastifyInstance, opts: { pool: Db; webhookSecret: string }) {
  // The signature covers the exact bytes, so this plugin keeps the raw body.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post<{ Params: { platform: string }; Body: string }>("/webhooks/:platform", async (req) => {
    const platform = req.params.platform;
    if (!(PLATFORMS as readonly string[]).includes(platform)) throw new HttpError(404, "unknown platform");

    const signature = req.headers[SIGNATURE_HEADER];
    if (!verifySignature(req.body, typeof signature === "string" ? signature : undefined, opts.webhookSecret)) {
      throw new HttpError(401, "invalid signature");
    }

    let json: unknown;
    try {
      json = JSON.parse(req.body);
    } catch {
      throw new HttpError(400, "body is not valid JSON");
    }
    const payload = parseOr400(webhookPayloadSchema, json);

    const eventId = await withTransaction(opts.pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into inbound_events (platform, external_event_id, kind, payload)
         values ($1, $2, $3, $4)
         on conflict (platform, external_event_id) do nothing
         returning id`,
        [platform, payload.eventId, payload.type, payload],
      );
      const id = rows[0]?.id;
      if (id) await addJob(client, "process_event", { eventId: id }, { jobKey: `event:${id}` });
      return id;
    });

    req.log.info({ eventId, externalEventId: payload.eventId, duplicate: !eventId }, "webhook accepted");
    // A duplicate is acknowledged too, so the platform stops retrying it.
    return { ok: true, duplicate: !eventId };
  });
}
