import { describe, expect, it } from "vitest";
import { advanceRun } from "../src/worker/advanceRun.js";
import { useHarness } from "./harness.js";

const h = useHarness();

const thanksDefinition = {
  trigger: { type: "comment_keyword", keywords: ["pricing"], postIds: null },
  steps: [
    { type: "reply_to_comment", text: "Sent you a DM!" },
    { type: "send_dm", text: "thanks {{username}}, here is the link" },
  ],
};

async function completedRun() {
  await h.createAutomation(thanksDefinition);
  await h.comment({ user: "ana", text: "pricing" });
  await h.drain();
  const [run] = await h.runs();
  expect(run!.status).toBe("completed");
  expect(h.mock.sent).toHaveLength(2);
  return run!;
}

const rewind = (runId: string) =>
  h.pool.query("update runs set status = 'running', current_step = 0 where id = $1", [runId]);

describe("idempotent outbound actions", () => {
  it("re-executing steps already recorded as sent does not call the platform again", async () => {
    const run = await completedRun();

    await rewind(run.id);
    await advanceRun(h.deps, run.id);
    await advanceRun(h.deps, run.id);

    expect(h.mock.calls).toHaveLength(2);
    expect(h.mock.sent).toHaveLength(2);
    expect((await h.runView(run.id)).outboundActions).toHaveLength(2);
  });

  it("a lost `sent` write makes us call again; only a provider honouring the key, like the mock, drops the duplicate", async () => {
    const run = await completedRun();

    // The provider accepted both messages, but our "sent" writes were lost. Instagram has no
    // idempotency key, so there this window would deliver the message twice.
    await h.pool.query("update outbound_actions set status = 'pending' where run_id = $1", [run.id]);
    await rewind(run.id);
    await advanceRun(h.deps, run.id);

    expect(h.mock.calls).toHaveLength(4);
    expect(h.mock.sent).toHaveLength(2);
    const actions = (await h.runView(run.id)).outboundActions;
    expect(actions.map((a) => a.status)).toEqual(["sent", "sent"]);
  });
});
