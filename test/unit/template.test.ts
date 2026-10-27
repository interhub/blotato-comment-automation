import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/domain/definition.js";

describe("renderTemplate", () => {
  const vars = { username: "ana", email: "jo+promo@gmail.com" };

  it("inserts values as is", () => {
    expect(renderTemplate("Hey {{username}}, sent to {{ email }}", vars)).toBe("Hey ana, sent to jo+promo@gmail.com");
  });

  it("encodes values with the url filter, so the landing page gets the exact email", () => {
    const link = renderTemplate("https://example.com/p?e={{email|url}}&u={{ username | url }}", vars);
    expect(link).toBe("https://example.com/p?e=jo%2Bpromo%40gmail.com&u=ana");
    expect(new URL(link).searchParams.get("e")).toBe("jo+promo@gmail.com");
  });

  it("renders a missing variable as empty", () => {
    expect(renderTemplate("e={{nope|url}}", vars)).toBe("e=");
  });
});
