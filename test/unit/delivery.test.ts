import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../../src/domain/webhook.js";
import { retryDelayMs } from "../../src/worker/outbound.js";

describe("retryDelayMs", () => {
  const policy = { baseMs: 100, capMs: 1_000, maxAttempts: 5 };

  it("grows exponentially with jitter and stays under the cap", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
      const delay = retryDelayMs(policy, attempt);
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it("prefers the provider's Retry-After", () => {
    expect(retryDelayMs(policy, 1, 5_000)).toBe(5_000);
  });
});

describe("webhook signature", () => {
  it("accepts the exact body and rejects anything else", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifySignature(body, signBody(body, "s3cret"), "s3cret")).toBe(true);
    expect(verifySignature(body + " ", signBody(body, "s3cret"), "s3cret")).toBe(false);
    expect(verifySignature(body, signBody(body, "other"), "s3cret")).toBe(false);
    expect(verifySignature(body, undefined, "s3cret")).toBe(false);
  });
});
