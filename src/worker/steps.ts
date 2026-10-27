import { renderTemplate } from "../domain/definition.js";
import { collectInput } from "./collectInput.js";
import type { WorkerDeps } from "./deps.js";
import { sendOnce, type SendOutcome } from "./outbound.js";
import type { Run } from "./runs.js";

export type StepResult =
  | { type: "next"; vars?: Record<string, string>; outcome?: string }
  | { type: "wait"; timeoutSeconds: number }
  | { type: "done"; outcome: string }
  | Exclude<SendOutcome, { type: "sent" }>;

export async function executeStep(deps: WorkerDeps, run: Run): Promise<StepResult> {
  const stepIndex = run.currentStep;
  const step = run.definition.steps[stepIndex]!;
  switch (step.type) {
    case "reply_to_comment":
      return sendThenNext(deps, run, "comment_reply", renderTemplate(step.text, run.context.vars));
    case "send_dm":
      return sendThenNext(deps, run, "dm", renderTemplate(step.text, run.context.vars));
    case "collect_input":
      return collectInput(deps, run, step);
  }
}

async function sendThenNext(deps: WorkerDeps, run: Run, kind: "comment_reply" | "dm", text: string): Promise<StepResult> {
  const sent = await sendOnce(deps, run, { kind, stepIndex: run.currentStep, seq: 0, text });
  return sent.type === "sent" ? { type: "next" } : sent;
}
