import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/globalSetup.ts"],
    // Integration tests share one database and truncate it between tests.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
