import { describe, expect, it } from "vitest";
import { pricingDefinition, pricingLink, useHarness } from "./harness.js";

const h = useHarness();

describe("happy path", () => {
  it("replies to the comment, asks for an email and sends the link", async () => {
    await h.createAutomation();

    expect((await h.comment({ user: "ana", text: "Pricing please!", commentId: "c1" })).statusCode).toBe(200);
    await h.drain();

    const [run] = await h.runs();
    expect(run).toMatchObject({ status: "waiting", current_step: 1, contact_id: "ana" });
    expect(h.mock.sent.map((m) => [m.kind, m.text])).toEqual([
      ["comment_reply", "Sent you a DM!"],
      ["dm", "Hey ana! What's the best email to send the pricing to?"],
    ]);
    expect(h.mock.sent[0]).toMatchObject({ commentId: "c1", accountId: "biz-account-1" });

    await h.dm({ user: "ana", text: "sure, it's Ana@Example.io!" });
    await h.drain();

    expect(h.mock.dmsTo("ana")).toEqual([
      "Hey ana! What's the best email to send the pricing to?",
      pricingLink("ana@example.io"),
    ]);
    const view = await h.runView(run!.id);
    expect(view.run).toMatchObject({ status: "completed", outcome: "email_collected" });
    expect(view.outboundActions.map((a) => a.request)).toEqual([
      { commentId: "c1", text: "Sent you a DM!" },
      { recipientId: "ana", commentId: "c1", text: "Hey ana! What's the best email to send the pricing to?" },
      { recipientId: "ana", text: pricingLink("ana@example.io") },
    ]);
    expect(view.run.context.vars.email).toBe("ana@example.io");
    expect(view.inputs).toHaveLength(1);
    expect(view.inputs[0]!.consumedAt).not.toBeNull();
    expect(view.outboundActions.map((a) => [a.kind, a.status, a.attempts])).toEqual([
      ["comment_reply", "sent", 1],
      ["dm", "sent", 1],
      ["dm", "sent", 1],
    ]);
  });

  it("opens the conversation with a private reply to the comment, then messages the person directly", async () => {
    await h.createAutomation(pricingDefinition({ maxReprompts: 1 }));
    await h.comment({ user: "ana", text: "pricing", commentId: "c1" });
    await h.drain();
    for (const text of ["how much?", "jo+promo@gmail.com"]) {
      await h.dm({ user: "ana", text });
      await h.drain();
    }

    const dms = h.mock.sent.filter((m) => m.kind === "dm");
    expect(dms.map((m) => [m.mode, m.commentId ?? null])).toEqual([
      ["private_reply", "c1"],
      ["recipient_id", null],
      ["recipient_id", null],
    ]);
    expect(dms.at(-1)!.text).toBe("Here you go: https://example.com/pricing?e=jo%2Bpromo%40gmail.com");
  });

  it("ignores comments without the keyword and the account's own comments", async () => {
    await h.createAutomation();
    await h.comment({ user: "bob", text: "love this post" });
    await h.comment({ user: "biz-account-1", text: "pricing is in your DMs" });
    await h.drain();

    expect(await h.runs()).toHaveLength(0);
    expect(h.mock.calls).toHaveLength(0);
  });
});
