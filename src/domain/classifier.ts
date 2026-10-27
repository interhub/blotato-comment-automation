export type ReplyClass =
  | { kind: "email"; email: string }
  | { kind: "typo" | "question" | "media" | "refusal" | "other" };

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;
const SPELLED_OUT_EMAIL = /\w+\s*[([]?\s*at\s*[)\]]?\s*\w+\s*[([]?\s*dot\s*[)\]]?\s*[a-z]{2,}/i;
const MAIL_PROVIDER = /\b(gmail|googlemail|yahoo|outlook|hotmail|icloud|proton(mail)?|aol)\b/i;
const REFUSAL_PHRASE = "no+|nope|nah|stop|unsubscribe|not interested|nevermind|never mind|pass|leave me alone|i'?m good|not now";
const POLITENESS = "thanks?|thank you|thx|ty|sorry|please|pls";
/** The whole message must be a no: "no thanks" and "nah i'm good" are, "no worries" and "pass me the link" are not. */
const REFUSAL = new RegExp(`^(?:${REFUSAL_PHRASE})(?: (?:${REFUSAL_PHRASE}|${POLITENESS}))*$`);
const QUESTION_START =
  /^(how|what|why|when|where|who|which|whats|what's|how's|can|could|would|will|is|are|do|does|did|should)\b/i;

/**
 * Sorts a DM reply into the categories from DESIGN.md 6.4. Order matters: an email anywhere
 * wins ("no wait, it's jo@x.io"), then typos, then a clear no, then questions.
 */
export function classifyReply(rawText: string, attachments = 0): ReplyClass {
  const text = rawText.trim();
  const email = EMAIL.exec(text)?.[0];
  if (email && !email.includes("..")) return { kind: "email", email: email.toLowerCase() };

  if (text.includes("@") || SPELLED_OUT_EMAIL.test(text) || MAIL_PROVIDER.test(text)) return { kind: "typo" };

  const words = text
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (REFUSAL.test(words)) return { kind: "refusal" };

  if (text.endsWith("?") || QUESTION_START.test(words)) return { kind: "question" };

  if (!/[\p{L}\p{N}]/u.test(text) && (text.length > 0 || attachments > 0)) return { kind: "media" };

  return { kind: "other" };
}
