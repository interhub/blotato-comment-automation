import { describe, expect, it } from "vitest";
import { processEvent } from "../src/worker/processEvent.js";
import { waitTimeout } from "../src/worker/waitTimeout.js";
import { pricingDefinition, pricingLink, useHarness } from "./harness.js";

const h = useHarness();

describe("waiting for a reply", () => {
  it("times out without a reply and ignores a reply that arrives later", async () => {
    await h.createAutomation(pricingDefinition({ timeoutSeconds: 0.5 }));
    await h.comment({ user: "ana", text: "pricing" });

    await h.drain(0);
    expect((await h.runs())[0]).toMatchObject({ status: "waiting" });

    await h.drain();
    const [run] = await h.runs();
    expect(run).toMatchObject({ status: "timed_out", outcome: null });
    expect(h.mock.sent.map((m) => m.kind)).toEqual(["comment_reply", "dm"]);

    await h.dm({ user: "ana", text: "ana@example.io" });
    await h.drain();

    expect((await h.runs())[0]!.status).toBe("timed_out");
    expect((await h.runView(run!.id)).inputs).toHaveLength(0);
    expect(h.mock.sent).toHaveLength(2);
  });

  it("captures a reply that arrives while the question is still being sent", async () => {
    await h.createAutomation();
    let statusWhenReplyArrived: string | undefined;

    // The reply lands inside the "network call" for the question, before the run is marked waiting.
    h.mock.onCall = async (call) => {
      if (call.kind !== "dm" || !call.text.startsWith("Hey")) return;
      await h.dm({ user: "ana", text: "ana@example.io", eventId: "fast-reply" });
      const { rows } = await h.pool.query("select id from inbound_events where external_event_id = 'fast-reply'");
      await processEvent(h.deps, rows[0].id);
      statusWhenReplyArrived = (await h.runs())[0]!.status;
    };

    await h.comment({ user: "ana", text: "pricing" });
    await h.drain();

    expect(statusWhenReplyArrived).toBe("running");
    const [run] = await h.runs();
    expect(run).toMatchObject({ status: "completed", outcome: "email_collected" });
    expect(h.mock.dmsTo("ana")).toEqual([
      "Hey ana! What's the best email to send the pricing to?",
      pricingLink("ana@example.io"),
    ]);
  });

  it("a DM sent before the question went out is not taken as the answer", async () => {
    await h.createAutomation();
    await h.dm({ user: "ana", text: "ana@example.io" });
    await h.drain();
    await h.comment({ user: "ana", text: "pricing" });
    await h.drain();

    const [run] = await h.runs();
    expect(run!.status).toBe("waiting");
    expect((await h.runView(run!.id)).inputs).toHaveLength(0);
  });

  it("a reply arriving exactly at the deadline either wins or is ignored, never both", async () => {
    await h.createAutomation();
    const users = Array.from({ length: 8 }, (_, i) => `user-${i}`);
    for (const user of users) await h.comment({ user, text: "pricing" });
    await h.drain();
    const runs = await h.runs();

    await Promise.all(
      runs.map(async (run) => {
        await h.reachDeadline(run.id);
        await h.dm({ user: run.contact_id, text: `${run.contact_id}@example.io`, eventId: `reply-${run.contact_id}` });
        const eventId = await h.eventId(`reply-${run.contact_id}`);
        await Promise.all([processEvent(h.deps, eventId), waitTimeout(h.deps, run.id, 1)]);
      }),
    );
    await h.drain();

    for (const run of await h.runs()) {
      const view = await h.runView(run.id);
      const prompt = `Hey ${run.contact_id}! What's the best email to send the pricing to?`;
      if (run.status === "completed") {
        expect(run.outcome).toBe("email_collected");
        expect(view.inputs).toHaveLength(1);
        expect(h.mock.dmsTo(run.contact_id)).toEqual([prompt, pricingLink(`${run.contact_id}@example.io`)]);
      } else {
        expect(run).toMatchObject({ status: "timed_out", outcome: null });
        expect(view.inputs).toHaveLength(0);
        expect(h.mock.dmsTo(run.contact_id)).toEqual([prompt]);
      }
    }
  });
});
