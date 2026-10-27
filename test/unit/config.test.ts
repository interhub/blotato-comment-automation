import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const saved = { NODE_ENV: process.env.NODE_ENV, WEBHOOK_SECRET: process.env.WEBHOOK_SECRET };

function setEnv(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe("loadConfig", () => {
  afterEach(() => setEnv(saved));

  it("refuses to start in production without WEBHOOK_SECRET", () => {
    setEnv({ NODE_ENV: "production", WEBHOOK_SECRET: undefined });
    expect(() => loadConfig()).toThrow(/WEBHOOK_SECRET/);
  });

  it("uses the given secret in production and the dev default elsewhere", () => {
    setEnv({ NODE_ENV: "production", WEBHOOK_SECRET: "prod-secret" });
    expect(loadConfig().webhookSecret).toBe("prod-secret");
    setEnv({ NODE_ENV: "development", WEBHOOK_SECRET: undefined });
    expect(loadConfig().webhookSecret).toBe("dev-webhook-secret");
  });
});
