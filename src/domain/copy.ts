import type { CollectInputStep, CopyCategory } from "./definition.js";

const DEFAULT_COPY: Record<CopyCategory, readonly string[]> = {
  typo: [
    "so close! looks like a typo, double-check it?",
    "almost there 👀 that email looks a little off, mind checking it?",
    "I think a letter or two went missing there. try once more?",
  ],
  question: [
    "good q! the link has every answer, just drop your email 💌",
    "totally fair question, it's all in the link. what email should I send it to?",
    "the link covers that, promise 🙌 just need your email first",
  ],
  media: [
    "love the vibe 😄 but I need an email to send it",
    "haha nice. now just type your email and it's yours ✨",
    "can't read emails from emojis yet 😅 mind typing it out?",
  ],
  other: [
    "hmm, that doesn't look like an email. try again?",
    "not quite an email yet 🤔 something like name@example.com works",
    "I might be missing it, could you send just your email?",
  ],
  declined: ["no worries! comment again anytime ✌️", "all good, no pressure. you know where to find us 👋"],
  signOff: [
    "no stress, let's leave it here. comment again whenever you want the link 🙂",
    "I'll stop bugging you 😌 comment again anytime and I'll send it over",
  ],
};

/** Rotates by a counter that grows with every reprompt, so the same line never repeats back to back. */
export function pickCopy(step: CollectInputStep, category: CopyCategory, counter: number): string {
  const options = step.copy?.[category] ?? DEFAULT_COPY[category];
  return options[counter % options.length]!;
}
