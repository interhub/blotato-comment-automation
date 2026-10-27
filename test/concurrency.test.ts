import { describe, expect, it } from "vitest";
import { pricingDefinition, pricingLink, useHarness, type RunRow } from "./harness.js";

const h = useHarness();
const PROMPT = "Hey ana! What's the best email to send the pricing to?";

/** Ana comments on two posts: the first run asks, the second waits in the queue. */
async function twoRunsForAna(collect: Record<string, unknown> = {}) {
  await h.createAutomation(pricingDefinition(collect));
  await h.comment({ user: "ana", text: "pricing", commentId: "c1" });
  await h.drain();
  await h.comment({ user: "ana", text: "pricing", commentId: "c2" });
  await h.drain();
  const runs = await h.runs();
  expect(runs.map((r) => [r.trigger_comment_id, r.status])).toEqual([
    ["c1", "waiting"],
    ["c2", "queued"],
  ]);
  return runs as [RunRow, RunRow];
}

/** The promoted run opened its own conversation with a private reply to its own comment. */
async function expectPromoted(runId: string) {
  expect((await h.runView(runId)).run.status).toBe("waiting");
  const opener = h.mock.sent.filter((m) => m.kind === "dm" && m.commentId === "c2");
  expect(opener.map((m) => m.text)).toEqual([PROMPT]);
}

describe("concurrent conversations", () => {
  it("two people commenting at the same time get independent runs", async () => {
    await h.createAutomation();
    await Promise.all([h.comment({ user: "ana", text: "pricing" }), h.comment({ user: "bob", text: "PRICING?" })]);
    await h.drain();

    expect((await h.runs()).map((r) => r.status)).toEqual(["waiting", "waiting"]);

    await h.dm({ user: "bob", text: "bob@example.io" });
    await h.drain();

    const byUser = Object.fromEntries((await h.runs()).map((r) => [r.contact_id, r.status]));
    expect(byUser).toEqual({ ana: "waiting", bob: "completed" });
    expect(h.mock.dmsTo("bob").at(-1)).toBe(pricingLink("bob@example.io"));

    await h.dm({ user: "ana", text: "ana@example.io" });
    await h.drain();

    expect((await h.runs()).every((r) => r.status === "completed")).toBe(true);
    expect(h.mock.dmsTo("ana").at(-1)).toBe(pricingLink("ana@example.io"));
  });

  it("one person commenting on two posts at once gets one conversation at a time", async () => {
    await h.createAutomation();
    await Promise.all([
      h.comment({ user: "ana", text: "pricing", postId: "post-1", commentId: "c1" }),
      h.comment({ user: "ana", text: "pricing", postId: "post-2", commentId: "c2" }),
    ]);
    await h.drain();

    const statuses = (await h.runs()).map((r) => r.status).sort();
    expect(statuses).toEqual(["queued", "waiting"]);
    expect(h.mock.sent.map((m) => m.kind)).toEqual(["comment_reply", "dm"]);
    const first = (await h.runs()).find((r) => r.status === "waiting")!;
    const second = (await h.runs()).find((r) => r.status === "queued")!;

    await h.dm({ user: "ana", text: "ana@example.io" });
    await h.drain();

    const firstView = await h.runView(first.id);
    const secondView = await h.runView(second.id);
    expect(firstView.run).toMatchObject({ status: "completed", outcome: "email_collected" });
    expect(firstView.inputs).toHaveLength(1);
    expect(secondView.run.status).toBe("waiting");
    expect(secondView.inputs).toHaveLength(0);
    expect(h.mock.sent.map((m) => m.kind)).toEqual(["comment_reply", "dm", "dm", "comment_reply", "dm"]);
    expect(h.mock.dmsTo("ana")).toEqual([
      "Hey ana! What's the best email to send the pricing to?",
      pricingLink("ana@example.io"),
      "Hey ana! What's the best email to send the pricing to?",
    ]);

    await h.dm({ user: "ana", text: "ana@work.io" });
    await h.drain();
    expect((await h.runView(second.id)).run.status).toBe("completed");
    expect(h.mock.dmsTo("ana").at(-1)).toBe(pricingLink("ana@work.io"));
  });

  it.each([
    {
      ending: "timed_out",
      collect: {},
      end: async (first: RunRow) => h.reachDeadline(first.id),
      expected: { status: "timed_out", outcome: null },
    },
    {
      ending: "failed",
      collect: {},
      end: async () => {
        h.mock.fail({ kind: "permanent", when: (c) => c.text.startsWith("Here you go") });
        await h.dm({ user: "ana", text: "ana@example.io" });
      },
      expected: { status: "failed" },
    },
    {
      ending: "declined",
      collect: {},
      end: async () => void (await h.dm({ user: "ana", text: "no thanks" })),
      expected: { status: "completed", outcome: "declined" },
    },
    {
      ending: "gave_up",
      collect: { maxReprompts: 0 },
      end: async () => void (await h.dm({ user: "ana", text: "hmm" })),
      expected: { status: "completed", outcome: "gave_up" },
    },
  ])("the queued run starts after the first one ends as $ending", async ({ collect, end, expected }) => {
    const [first, second] = await twoRunsForAna(collect);
    await end(first);
    await h.drain();

    expect((await h.runView(first.id)).run).toMatchObject(expected);
    await expectPromoted(second.id);
  });

  it("a queued run past the private reply window ends as expired and the next one starts", async () => {
    const [, second] = await twoRunsForAna();
    await h.comment({ user: "ana", text: "pricing", commentId: "c3" });
    await h.drain();
    await h.pool.query("update runs set created_at = created_at - interval '8 days' where id = $1", [second.id]);
    const sentBefore = h.mock.sent.length;

    await h.dm({ user: "ana", text: "ana@example.io" });
    await h.drain();

    const expired = await h.runView(second.id);
    expect(expired.run).toMatchObject({ status: "failed", outcome: "expired" });
    expect(expired.outboundActions).toEqual([]);
    expect(h.mock.calls.some((c) => c.kind === "comment_reply" && c.commentId === "c2")).toBe(false);

    const third = (await h.runs()).find((r) => r.trigger_comment_id === "c3")!;
    expect(third.status).toBe("waiting");
    expect(h.mock.sent.slice(sentBefore).map((m) => [m.kind, m.commentId ?? null])).toEqual([
      ["dm", null],
      ["comment_reply", "c3"],
      ["dm", "c3"],
    ]);
  });
});
