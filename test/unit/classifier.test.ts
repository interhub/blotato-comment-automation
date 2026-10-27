import { describe, expect, it } from "vitest";
import { classifyReply } from "../../src/domain/classifier.js";

describe("classifyReply", () => {
  it.each([
    ["jo@x.io", "jo@x.io"],
    ["sure, it's Jo.Doe+promo@Example.co.uk!", "jo.doe+promo@example.co.uk"],
    ["no wait, use jo@x.io", "jo@x.io"],
  ])("extracts the email from %j", (text, email) => {
    expect(classifyReply(text)).toEqual({ kind: "email", email });
  });

  it.each([
    ["jo@gmail", "typo"],
    ["jo@gmail.c", "typo"],
    ["jo at gmail dot com", "typo"],
    ["jo(at)gmail(dot)com", "typo"],
    ["jo..doe@x..io", "typo"],
    ["it's my gmail", "typo"],
    ["how much is it?", "question"],
    ["what does it include", "question"],
    ["🔥🔥🔥", "media"],
    ["😍 !!", "media"],
    ["nothing to add", "other"],
    ["hello", "other"],
    ["", "other"],
  ])("%j -> %s", (text, kind) => {
    expect(classifyReply(text).kind).toBe(kind);
  });

  it.each(["no", "No thanks!", "nah", "Nope.", "stop", "STOP 🛑", "not interested", "unsubscribe", "nah I’m good", "no thank you 🙏"])(
    "%j is a refusal",
    (text) => {
      expect(classifyReply(text).kind).toBe("refusal");
    },
  );

  it.each(["no problem, send it!", "no worries", "pass me the link", "i'm good with that", "stop by later?", "nah send it"])(
    "%j is not a refusal",
    (text) => {
      expect(classifyReply(text).kind).not.toBe("refusal");
    },
  );

  it("treats an attachment without text as media", () => {
    expect(classifyReply("", 1).kind).toBe("media");
  });
});
