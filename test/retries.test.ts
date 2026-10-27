import { describe, expect, it } from "vitest";
import { processEvent } from "../src/worker/processEvent.js";
import { useHarness, type Harness } from "./harness.js";

const h = useHarness({ baseMs: 20, capMs: 1_000, maxAttempts: 4 });

const isLink = (call: { text: string }) => call.text.startsWith("Here you go");

async function reachLinkStep(harness: Harness) {
  await harness.createAutomation();
  await harness.comment({ user: "ana", text: "pricing" });
  await harness.drain();
  await harness.dm({ user: "ana", text: "ana@example.io" });
  await harness.drain();
  const [run] = await harness.runs();
  return run!;
}

describe("outbound retries", () => {
  it("retries transient failures with growing backoff and delivers once", async () => {
    h.mock.fail({ kind: "transient", times: 2, when: isLink });
    const run = await reachLinkStep(h);

    expect(run).toMatchObject({ status: "completed", outcome: "email_collected", last_error: null });
    expect(h.mock.sent.filter(isLink)).toHaveLength(1);

    const link = (await h.runView(run.id)).outboundActions.find((a) => a.idempotencyKey.endsWith(":2:0"))!;
    expect(link).toMatchObject({ status: "sent", attempts: 3 });
    const delays = link.attemptLog.map((entry) => entry.retryInMs!);
    expect(delays).toHaveLength(2);
    // base * 2^(attempt-1) with jitter 0.5..1: [10..20], then [20..40]
    expect(delays[0]).toBeGreaterThanOrEqual(10);
    expect(delays[0]).toBeLessThanOrEqual(20);
    expect(delays[1]).toBeGreaterThanOrEqual(20);
    expect(delays[1]).toBeLessThanOrEqual(40);
    expect(delays[1]).toBeGreaterThanOrEqual(delays[0]!);

    const attemptsAt = h.mock.calls.filter(isLink).map((c) => c.at);
    expect(attemptsAt).toHaveLength(3);
    expect(attemptsAt[1]! - attemptsAt[0]!).toBeGreaterThanOrEqual(delays[0]! - 5);
    expect(attemptsAt[2]! - attemptsAt[1]!).toBeGreaterThanOrEqual(delays[1]! - 5);
  });

  it("a Retry-After hint wins over the backoff formula", async () => {
    h.mock.fail({ kind: "transient", times: 1, retryAfterMs: 150, when: isLink });
    const run = await reachLinkStep(h);

    expect(run.status).toBe("completed");
    const link = (await h.runView(run.id)).outboundActions.find((a) => a.idempotencyKey.endsWith(":2:0"))!;
    expect(link.attemptLog.map((e) => e.retryInMs)).toEqual([150]);
    const [first, second] = h.mock.calls.filter(isLink).map((c) => c.at);
    expect(second! - first!).toBeGreaterThanOrEqual(145);
  });

  it("fails the run immediately on a permanent error", async () => {
    h.mock.fail({ kind: "permanent", when: (c) => c.kind === "dm" });
    await h.createAutomation();
    await h.comment({ user: "ana", text: "pricing" });
    await h.drain();

    const [run] = await h.runs();
    expect(run).toMatchObject({ status: "failed" });
    expect(run!.last_error).toContain("permanent");
    expect(h.mock.calls.filter((c) => c.kind === "dm")).toHaveLength(1);
    const prompt = (await h.runView(run!.id)).outboundActions.find((a) => a.kind === "dm")!;
    expect(prompt).toMatchObject({ status: "failed", attempts: 1 });

    const jobs = await h.pool.query(
      "select task_identifier, key, run_at - now() as run_in, locked_at, attempts, last_error from graphile_worker.jobs",
    );
    expect(jobs.rows).toEqual([]);
  });

  it("fails the run with last_error once retries are exhausted", async () => {
    h.mock.fail({ kind: "transient", times: Infinity, when: (c) => c.kind === "comment_reply" });
    await h.createAutomation();
    await h.comment({ user: "ana", text: "pricing" });
    await h.drain();

    const [run] = await h.runs();
    expect(run!.status).toBe("failed");
    expect(run!.last_error).toContain("attempt 4");
    expect(h.mock.calls).toHaveLength(4);
    expect(h.mock.sent).toHaveLength(0);

    const reply = (await h.runView(run!.id)).outboundActions[0]!;
    expect(reply).toMatchObject({ status: "failed", attempts: 4 });
    expect(reply.attemptLog.map((e) => e.retryInMs === null)).toEqual([false, false, false, true]);
  });

  it("a successful send after a transient failure leaves the waiting run without last_error", async () => {
    h.mock.fail({ kind: "transient", times: 1, when: (c) => c.kind === "dm" });
    await h.createAutomation();
    await h.comment({ user: "ana", text: "pricing" });
    await h.drain();

    const [run] = await h.runs();
    expect(run).toMatchObject({ status: "waiting", last_error: null });
    expect(h.mock.calls.filter((c) => c.kind === "dm")).toHaveLength(2);
  });

  it("a run whose job keeps crashing is failed and the person's next run starts", async () => {
    // Not a PlatformError: an adapter bug or a database error that retrying the send cannot classify.
    h.mock.onCall = (call) => {
      if (call.kind === "dm" && call.commentId === "c1") throw new Error("adapter bug");
    };
    await h.createAutomation();
    for (const commentId of ["c1", "c2"]) {
      await h.comment({ user: "ana", text: "pricing", commentId, eventId: commentId });
      await processEvent(h.deps, await h.eventId(commentId));
    }
    expect(await h.runJobsNow()).toContain("adapter bug");

    const [first, second] = await h.runs();
    expect(first).toMatchObject({ trigger_comment_id: "c1", status: "running" });
    expect(second).toMatchObject({ trigger_comment_id: "c2", status: "queued" });

    // advanceRunMaxAttempts is 2 in the harness: the second crash closes the run instead of rethrowing.
    expect(await h.runJobsNow()).toBeNull();
    const runs = await h.runs();
    expect(runs[0]).toMatchObject({ status: "failed" });
    expect(runs[0]!.last_error).toMatch(/advance_run failed 2 times: adapter bug/);
    expect(runs[1]).toMatchObject({ status: "waiting" });
    expect(h.mock.dmsTo("ana")).toEqual(["Hey ana! What's the best email to send the pricing to?"]);
  });
});
