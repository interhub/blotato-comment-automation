import { describe, expect, it } from "vitest";
import { deleteExpiredSandboxes, type OutboundItem, type SandboxState } from "../src/demo/sandbox.js";
import { useHarness } from "./harness.js";

const h = useHarness({}, { demo: true });

const A = "sandbox-aaaa-1111";
const B = "sandbox-bbbb-2222";

const post = (sandbox: string, path: string, payload: object) =>
  h.app.inject({ method: "POST", url: `/demo/${sandbox}/${path}`, payload });

async function state(sandbox: string): Promise<SandboxState & { faultsArmed: string[] }> {
  const res = await h.app.inject({ method: "GET", url: `/demo/${sandbox}/state` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("demo playground", () => {
  it("runs the whole flow inside one sandbox and shows nothing of it in another", async () => {
    await post(A, "comment", { username: "@Ana.K", text: "pricing?" });
    await h.drain();
    await post(A, "message", { username: "ana.k", text: "jo+promo@gmail.com" });
    await h.drain();

    const a = await state(A);
    expect(a.automation.form.timeoutSeconds).toBe(120);
    const ana = a.people.find((p) => p.username === "ana.k")!;
    expect(ana.timeline.map((t) => t.kind)).toEqual(["comment", "comment_reply", "dm_out", "dm_in", "dm_out"]);
    const sent = ana.timeline.filter((t): t is OutboundItem => t.kind === "dm_out");
    expect(sent.map((t) => t.mode)).toEqual(["private_reply", "recipient_id"]);
    expect(sent[1]!.text).toBe("Here you go: https://example.com/pricing?e=jo%2Bpromo%40gmail.com");
    expect(ana.runs).toMatchObject([{ status: "completed", outcome: "email_collected", postId: "post-1" }]);

    const b = await state(B);
    expect(b.people).toEqual([]);
    expect(b.automation.id).not.toBe(a.automation.id);
  });

  it("delivers a comment webhook three times with one event id and starts one run", async () => {
    const res = await post(A, "comment", { username: "ben", text: "price", copies: 3 });
    const { deliveries } = res.json<{ deliveries: { statusCode: number; duplicate: boolean }[] }>();
    expect(deliveries.map((d) => d.statusCode)).toEqual([200, 200, 200]);
    expect(deliveries.filter((d) => d.duplicate)).toHaveLength(2);
    await h.drain();

    const ben = (await state(A)).people.find((p) => p.username === "ben")!;
    expect(ben.runs).toHaveLength(1);
    expect(ben.timeline.filter((t) => t.kind === "comment")).toHaveLength(1);
    expect(h.mock.sent.filter((m) => m.kind === "comment_reply")).toHaveLength(1);
  });

  it("scripts failures for its own account only and shows the attempts", async () => {
    await post(A, "faults", { transient: 2 });
    expect((await state(A)).faultsArmed).toEqual(["transient", "transient"]);
    expect((await state(B)).faultsArmed).toEqual([]);

    await post(B, "comment", { username: "cy", text: "pricing" });
    await post(A, "comment", { username: "cy", text: "pricing" });
    await h.drain(5_000);

    const replyIn = async (sandbox: string) =>
      (await state(sandbox)).people[0]!.timeline.find((t) => t.kind === "comment_reply")!;
    expect(await replyIn(A)).toMatchObject({ status: "sent", attempts: 3 });
    expect(await replyIn(B)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("edits the automation through a new version and validates input", async () => {
    const before = await state(A);
    const res = await h.app.inject({
      method: "PUT",
      url: `/demo/${A}/automation`,
      payload: { ...before.automation.form, keywords: ["menu"], timeoutSeconds: 30 },
    });
    expect(res.statusCode).toBe(200);
    const after = await state(A);
    expect(after.automation.version).toBe(before.automation.version + 1);
    expect(after.automation.form.keywords).toEqual(["menu"]);

    expect((await post(A, "comment", { username: "bad name!", text: "x" })).statusCode).toBe(400);
    expect((await post(A, "message", { username: "ana" })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "GET", url: "/demo/x/state" })).statusCode).toBe(404);
  });

  it("deletes sandboxes older than a day with everything they produced", async () => {
    await post(A, "comment", { username: "ana", text: "pricing" });
    await post(B, "comment", { username: "ana", text: "pricing" });
    await h.drain();
    await h.pool.query("update social_accounts set created_at = now() - interval '25 hours' where external_account_id = $1", [
      `demo-${A}`,
    ]);

    expect(await deleteExpiredSandboxes(h.pool)).toBe(1);
    const accounts = await h.pool.query("select external_account_id from social_accounts");
    expect(accounts.rows.map((r) => r.external_account_id)).toEqual([`demo-${B}`]);
    expect((await h.pool.query("select 1 from inbound_events")).rowCount).toBe(1);
    expect((await h.pool.query("select 1 from runs")).rowCount).toBe(1);
  });
});
