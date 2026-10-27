const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive match: "Pricing please!" matches "pricing", "pricingless" does not. */
export function matchesKeyword(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => {
    const words = keyword.trim().split(/\s+/).map(escape).join("\\s+");
    return new RegExp(`(?<![\\p{L}\\p{N}_])${words}(?![\\p{L}\\p{N}_])`, "iu").test(text);
  });
}
