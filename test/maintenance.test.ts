import { describe, expect, it } from "vitest";
import { addJob } from "../src/jobs.js";
import { useHarness } from "./harness.js";

const h = useHarness();

const queues = async () =>
  (await h.pool.query<{ queue_name: string }>("select queue_name from graphile_worker._private_job_queues order by 1")).rows.map(
    (r) => r.queue_name,
  );

describe("job queue cleanup", () => {
  it("gc_job_queues drops the queues of finished runs and keeps the ones still in use", async () => {
    await h.createAutomation();
    await h.comment({ user: "ana", text: "pricing" });
    await h.comment({ user: "bob", text: "pricing" });
    await h.drain();
    await h.dm({ user: "bob", text: "bob@example.io" });
    await h.drain();

    const runs = Object.fromEntries((await h.runs()).map((r) => [r.contact_id, r]));
    expect(runs.ana!.status).toBe("waiting");
    expect(runs.bob!.status).toBe("completed");
    expect(await queues()).toEqual([`run:${runs.ana!.id}`, `run:${runs.bob!.id}`].sort());

    await addJob(h.pool, "gc_job_queues", {});
    await h.drain();

    expect(await queues()).toEqual([`run:${runs.ana!.id}`]);
  });
});
