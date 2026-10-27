import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { HttpError, idOr404 } from "./http.js";

/** The support view: "why didn't this person get the link?" */
export async function runRoutes(app: FastifyInstance, opts: { pool: Db }) {
  const { pool } = opts;

  app.get<{ Params: { id: string } }>("/runs/:id", async (req) => {
    const id = idOr404(req.params.id);
    const { rows } = await pool.query(
      `select id, automation_id as "automationId", automation_version as "automationVersion",
              contact_id as "contactId", trigger_comment_id as "triggerCommentId", status, outcome,
              current_step as "currentStep", context, input_opened_at as "inputOpenedAt",
              wait_deadline as "waitDeadline", last_error as "lastError",
              created_at as "createdAt", updated_at as "updatedAt"
       from runs where id = $1`,
      [id],
    );
    if (!rows[0]) throw new HttpError(404, "not found");

    const [inputs, outboundActions] = await Promise.all([
      pool.query(
        `select id, inbound_event_id as "inboundEventId", text, attachments,
                received_at as "receivedAt", consumed_at as "consumedAt"
         from run_inputs where run_id = $1 order by received_at, id`,
        [id],
      ),
      pool.query(
        `select id, step_index as "stepIndex", idempotency_key as "idempotencyKey", kind, request, status,
                attempts, attempt_log as "attemptLog", provider_message_id as "providerMessageId",
                last_error as "lastError", created_at as "createdAt", updated_at as "updatedAt"
         from outbound_actions where run_id = $1 order by created_at, step_index, idempotency_key`,
        [id],
      ),
    ]);
    return { run: rows[0], inputs: inputs.rows, outboundActions: outboundActions.rows };
  });
}
