import { describe, expect, it } from "vitest";
import { processEvent } from "../src/worker/processEvent.js";
import { pricingDefinition, pricingLink, useHarness } from "./harness.js";

const h = useHarness();
const PROMPT = "Hey ana! What's the best email to send the pricing to?";

async function startConversation(collect: Record<string, unknown> = {}) {
  await h.createAutomation(pricingDefinition(collect));
  await h.comment({ user: "ana", text: "pricing" });
  await h.drain();
}

async function reply(text: string, attachments = 0) {
  await h.dm({ user: "ana", text, attachments });
  await h.drain();
  return h.mock.dmsTo("ana").at(-1);
}

async function onlyRun() {
  const [run] = await h.runs();
  return run!;
}

describe("replies that are not an email", () => {
  it("answers a question with a nudge, then accepts the email", async () => {
    await startConversation();

    expect(await reply("how much is it?")).toMatch(/link|email/i);
    expect((await onlyRun()).status).toBe("waiting");

    expect(await reply("ok jo@example.io")).toBe(pricingLink("jo@example.io"));
    expect(await onlyRun()).toMatchObject({ status: "completed", outcome: "email_collected" });
  });

  it("nudges on emoji-only and attachment-only replies", async () => {
    await startConversation();

    const emoji = await reply("🔥🔥😍");
    const sticker = await reply("", 1);
    expect(emoji).toMatch(/email/i);
    expect(sticker).toMatch(/email/i);
    expect(emoji).not.toBe(sticker);
    expect((await onlyRun()).status).toBe("waiting");
  });

  it("points out a near-miss email as a typo", async () => {
    await startConversation();
    expect(await reply("jo@gmail")).toMatch(/typo|off|missing/i);
    expect(await reply("jo at gmail dot com")).toMatch(/typo|off|missing/i);
  });

  it("ends politely on a refusal and sends nothing after", async () => {
    await startConversation();

    expect(await reply("no thanks")).toMatch(/no worries|no pressure/i);
    expect(await onlyRun()).toMatchObject({ status: "completed", outcome: "declined" });

    await reply("actually jo@example.io");
    expect(h.mock.dmsTo("ana")).toHaveLength(2);
  });

  it("signs off after maxReprompts and gives up", async () => {
    await startConversation({ maxReprompts: 2 });

    const first = await reply("hmm");
    const second = await reply("idk");
    const signOff = await reply("whatever");
    expect(first).not.toBe(second);
    expect(signOff).toMatch(/comment again/i);
    expect(await onlyRun()).toMatchObject({ status: "completed", outcome: "gave_up" });
    expect(h.mock.dmsTo("ana")).toEqual([PROMPT, first, second, signOff]);

    await reply("jo@example.io");
    expect(h.mock.dmsTo("ana")).toHaveLength(4);
  });

  it("never repeats the same line back to back", async () => {
    await startConversation({ maxReprompts: 5 });
    const lines = [];
    for (const text of ["hmm", "hmm", "hmm", "what", "what"]) lines.push(await reply(text));
    for (let i = 1; i < lines.length; i++) expect(lines[i]).not.toBe(lines[i - 1]);
  });

  it("uses the automation's own copy when provided", async () => {
    await startConversation({ copy: { other: ["Need an email to send it, friend."] } });
    expect(await reply("hello")).toBe("Need an email to send it, friend.");
  });

  it("a message sent together with an answer does not leak into the next question", async () => {
    await h.createAutomation({
      trigger: { type: "comment_keyword", keywords: ["pricing"], postIds: null },
      steps: [
        { type: "collect_input", prompt: "What's your personal email?", saveAs: "email" },
        { type: "collect_input", prompt: "And your work email?", saveAs: "work_email" },
        { type: "send_dm", text: "Got {{email}} and {{work_email}}" },
      ],
    });
    await h.comment({ user: "ana", text: "pricing" });
    await h.drain();

    // Both messages are routed before the run reacts to either, as when they are sent together.
    await h.dm({ user: "ana", text: "ana@x.io", eventId: "answer" });
    await h.dm({ user: "ana", text: "thanks!", eventId: "extra" });
    await processEvent(h.deps, await h.eventId("answer"));
    await processEvent(h.deps, await h.eventId("extra"));
    await h.drain();

    expect(h.mock.dmsTo("ana")).toEqual(["What's your personal email?", "And your work email?"]);
    const run = await onlyRun();
    expect(run).toMatchObject({ status: "waiting", current_step: 1 });
    expect((await h.runView(run.id)).inputs.map((i) => [i.text, i.consumedAt !== null])).toEqual([
      ["ana@x.io", true],
      ["thanks!", true],
    ]);

    expect(await reply("ana@work.io")).toBe("Got ana@x.io and ana@work.io");
    expect(await onlyRun()).toMatchObject({ status: "completed", outcome: "work_email_collected" });
  });
});
