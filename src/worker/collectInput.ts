import { lockContact, withTransaction } from "../db.js";
import { classifyReply } from "../domain/classifier.js";
import { pickCopy } from "../domain/copy.js";
import { renderTemplate, type CollectInputStep } from "../domain/definition.js";
import type { WorkerDeps } from "./deps.js";
import { consumeInput, nextInput } from "./inputs.js";
import { sendOnce } from "./outbound.js";
import type { Run } from "./runs.js";
import type { StepResult } from "./steps.js";

/**
 * Ask, then wait for a valid answer. Every send is keyed by the reply counter and every
 * input is consumed only after its answer went out, so re-running this step after a crash
 * or a retry repeats nothing and loses nothing.
 */
export async function collectInput(deps: WorkerDeps, run: Run, step: CollectInputStep): Promise<StepResult> {
  const { pool } = deps;
  const stepIndex = run.currentStep;
  const dm = (seq: number, text: string) => sendOnce(deps, run, { kind: "dm", stepIndex, seq, text });

  if (!run.inputOpenedAt) {
    // Committed before the question goes out, so a reply that beats the "waiting" status is still captured;
    // taken under the same lock as DM routing, so routing never reads a half-opened window.
    await withTransaction(pool, async (client) => {
      await lockContact(client, run.accountId, run.contactId);
      await client.query(
        "update runs set input_opened_at = now(), updated_at = now() where id = $1 and input_opened_at is null",
        [run.id],
      );
    });
  }
  const prompt = await dm(0, renderTemplate(step.prompt, run.context.vars));
  if (prompt.type !== "sent") return prompt;

  let replies = run.context.replies;
  for (;;) {
    const input = await nextInput(pool, run.id);
    if (!input) return { type: "wait", timeoutSeconds: step.timeoutSeconds };

    const reply = classifyReply(input.text, input.attachments);
    if (reply.kind === "email") {
      return { type: "next", vars: { [step.saveAs]: reply.email }, outcome: `${step.saveAs}_collected` };
    }

    const seq = replies + 1;
    if (reply.kind === "refusal" || seq > step.maxReprompts) {
      const declined = reply.kind === "refusal";
      const sent = await dm(seq, pickCopy(step, declined ? "declined" : "signOff", seq));
      if (sent.type !== "sent") return sent;
      return { type: "done", outcome: declined ? "declined" : "gave_up" };
    }

    const sent = await dm(seq, pickCopy(step, reply.kind, seq));
    if (sent.type !== "sent") return sent;
    await withTransaction(pool, async (client) => {
      await consumeInput(client, input.id);
      await client.query(
        "update runs set context = jsonb_set(context, '{replies}', to_jsonb($2::int)), updated_at = now() where id = $1",
        [run.id, seq],
      );
    });
    replies = seq;
  }
}
