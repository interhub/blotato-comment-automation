import { makeWorkerUtils, parseCronItems, type ParsedCronItem, type TaskList } from "graphile-worker";
import { z } from "zod";
import { graphileLogger } from "../logger.js";
import { advanceRun } from "./advanceRun.js";
import type { WorkerDeps } from "./deps.js";
import { processEvent } from "./processEvent.js";
import { failRun } from "./runs.js";
import { waitTimeout } from "./waitTimeout.js";

const eventPayload = z.object({ eventId: z.uuid() });
const runPayload = z.object({ runId: z.uuid() });
const timeoutPayload = z.object({ runId: z.uuid(), stepIndex: z.number().int().min(0) });

/** Every run gets its own named queue and graphile-worker never deletes queue rows by itself. */
export const cronItems: ParsedCronItem[] = parseCronItems([{ task: "gc_job_queues", match: "0 * * * *" }]);

export function createTaskList(deps: WorkerDeps): TaskList {
  return {
    process_event: async (payload) => processEvent(deps, eventPayload.parse(payload).eventId),

    advance_run: async (payload, helpers) => {
      const { runId } = runPayload.parse(payload);
      try {
        await advanceRun(deps, runId);
      } catch (error) {
        // A bug or a database error, not a platform answer. Retry a few times, then end the run so
        // the person's queued runs move on. The job keeps graphile's own higher limit, so failing to
        // close the run (database down) is retried as well.
        if (helpers.job.attempts < Math.min(deps.advanceRunMaxAttempts, helpers.job.max_attempts)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        await failRun(deps.pool, runId, `advance_run failed ${helpers.job.attempts} times: ${message}`);
        deps.logger.error({ runId, err: error }, "run failed after repeated job errors");
      }
    },

    wait_timeout: async (payload) => {
      const { runId, stepIndex } = timeoutPayload.parse(payload);
      await waitTimeout(deps, runId, stepIndex);
    },

    // Safe while workers run: queues that hold a job or are locked by a running one are kept, and a
    // run adds jobs to its queue only while the queue holds one (its running advance_run or pending
    // timeout) or in the transaction that creates the queue, which the cleanup cannot see yet.
    gc_job_queues: async () => {
      const utils = await makeWorkerUtils({ pgPool: deps.pool, logger: graphileLogger(deps.logger) });
      try {
        await utils.cleanup({ tasks: ["GC_JOB_QUEUES"] });
      } finally {
        await utils.release();
      }
    },
  };
}
