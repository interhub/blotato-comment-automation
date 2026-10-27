import { parseCronItems, type ParsedCronItem, type TaskList } from "graphile-worker";
import type { Db } from "../db.js";
import type { Logger } from "../logger.js";
import { deleteExpiredSandboxes } from "./sandbox.js";

export const demoCronItems: ParsedCronItem[] = parseCronItems([{ task: "demo_cleanup", match: "*/15 * * * *" }]);

export function demoTaskList(pool: Db, logger: Logger): TaskList {
  return {
    demo_cleanup: async () => {
      const deleted = await deleteExpiredSandboxes(pool);
      if (deleted > 0) logger.info({ deleted }, "expired demo sandboxes deleted");
    },
  };
}
