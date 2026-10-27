import { describe, expect, it } from "vitest";
import { signBody } from "../src/domain/webhook.js";
import { pricingDefinition, pricingLink, useHarness } from "./harness.js";

const h = useHarness();

describe("HTTP API", () => {
  it("rejects a webhook with a bad signature and stores nothing", async () => {
    const res = await h.postWebhook({ eventId: "e1" }, "sha256=deadbeef");
    expect(res.statusCode).toBe(401);
    expect((await h.pool.query("select 1 from inbound_events")).rowCount).toBe(0);
  });

  it("rejects a signature of the right length made with another secret", async () => {
    const payload = { eventId: "e1", type: "comment" };
    const forged = signBody(JSON.stringify(payload), "not-the-secret");
    expect(forged).toHaveLength(signBody(JSON.stringify(payload), "test-secret").length);

    expect((await h.postWebhook(payload, forged)).statusCode).toBe(401);
    expect((await h.pool.query("select 1 from inbound_events")).rowCount).toBe(0);
  });

  it("rejects a signed but malformed payload and unknown platforms", async () => {
    expect((await h.postWebhook({ eventId: "e1", type: "comment" })).statusCode).toBe(400);
    const res = await h.app.inject({ method: "POST", url: "/webhooks/myspace", payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("validates definitions on write", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/automations",
      payload: {
        platform: "instagram",
        accountId: "biz",
        name: "broken",
        definition: { trigger: { type: "comment_keyword", keywords: [] }, steps: [{ type: "teleport" }] },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("an edit creates a new version and a running conversation keeps its own", async () => {
    const automation = await h.createAutomation();
    await h.comment({ user: "ana", text: "pricing" });
    await h.drain();

    const v2 = pricingDefinition();
    v2.steps[2] = { type: "send_dm", text: "New link: https://example.com/v2?e={{email|url}}" };
    const put = await h.app.inject({ method: "PUT", url: `/automations/${automation.id}`, payload: { definition: v2 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ version: 2, definition: v2 });

    await h.dm({ user: "ana", text: "ana@example.io" });
    await h.drain();
    expect(h.mock.dmsTo("ana").at(-1)).toBe(pricingLink("ana@example.io"));

    await h.comment({ user: "bob", text: "pricing" });
    await h.drain();
    await h.dm({ user: "bob", text: "bob@example.io" });
    await h.drain();
    expect(h.mock.dmsTo("bob").at(-1)).toBe("New link: https://example.com/v2?e=bob%40example.io");

    const get = await h.app.inject({ method: "GET", url: `/automations/${automation.id}` });
    expect(get.json().recentRuns.map((r: { version: number }) => r.version).sort()).toEqual([1, 2]);
  });

  it("returns 404 for unknown ids and reports health", async () => {
    expect((await h.app.inject({ method: "GET", url: "/runs/not-a-uuid" })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/runs/00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
  });

  it("does not mount the playground unless demo mode is on", async () => {
    expect((await h.app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/demo/sandbox-aaaa-1111/state" })).statusCode).toBe(404);
  });
});
