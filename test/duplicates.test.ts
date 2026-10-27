import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";

const h = useHarness();

const count = async (table: string) => (await h.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

describe("duplicate delivery", () => {
  it("the same comment webhook delivered 3 times concurrently starts one run", async () => {
    await h.createAutomation();

    const responses = await Promise.all(
      [1, 2, 3].map(() => h.comment({ user: "ana", text: "pricing", commentId: "c1", eventId: "evt-1" })),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(responses.filter((r) => r.json().duplicate)).toHaveLength(2);

    await h.drain();

    expect(await count("inbound_events")).toBe(1);
    expect(await count("runs")).toBe(1);
    expect(h.mock.sent.map((m) => m.kind)).toEqual(["comment_reply", "dm"]);
  });

  it("the same comment re-sent under a new event id still starts one run", async () => {
    await h.createAutomation();

    await h.comment({ user: "ana", text: "pricing", commentId: "c1", eventId: "evt-1" });
    await h.comment({ user: "ana", text: "pricing", commentId: "c1", eventId: "evt-1-redelivered" });
    await h.drain();

    expect(await count("inbound_events")).toBe(2);
    expect(await count("runs")).toBe(1);
    expect(h.mock.sent.filter((m) => m.kind === "comment_reply")).toHaveLength(1);
  });

  it("the same DM delivered twice is consumed once", async () => {
    await h.createAutomation();
    await h.comment({ user: "ana", text: "pricing" });
    await h.drain();

    await Promise.all([
      h.dm({ user: "ana", text: "wait how much is it?", eventId: "dm-1" }),
      h.dm({ user: "ana", text: "wait how much is it?", eventId: "dm-1" }),
    ]);
    await h.drain();
    await h.dm({ user: "ana", text: "wait how much is it?", eventId: "dm-1" });
    await h.drain();

    const [run] = await h.runs();
    const view = await h.runView(run!.id);
    expect(view.inputs).toHaveLength(1);
    // prompt + exactly one reprompt for the question
    expect(h.mock.dmsTo("ana")).toHaveLength(2);
    expect(run!.status).toBe("waiting");
  });
});
