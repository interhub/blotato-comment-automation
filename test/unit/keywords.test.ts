import { describe, expect, it } from "vitest";
import { matchesKeyword } from "../../src/domain/keywords.js";

describe("matchesKeyword", () => {
  it.each([
    ["pricing", true],
    ["Pricing please!", true],
    ["what's the PRICING?", true],
    ["#pricing", true],
    ["pricing,", true],
    ["pricingless", false],
    ["repricing", false],
    ["price", false],
    ["", false],
  ])("%j -> %s", (text, expected) => {
    expect(matchesKeyword(text, ["pricing"])).toBe(expected);
  });

  it("matches multi-word keywords across extra spaces and any of several keywords", () => {
    expect(matchesKeyword("send the price  list pls", ["price list"])).toBe(true);
    expect(matchesKeyword("demo?", ["pricing", "demo"])).toBe(true);
  });

  it("treats regex characters in keywords literally", () => {
    expect(matchesKeyword("c++ course", ["c++"])).toBe(true);
    expect(matchesKeyword("cxx course", ["c.."])).toBe(false);
  });
});
