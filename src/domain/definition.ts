import { z } from "zod";

const text = z.string().trim().min(1).max(1000);
const phrasings = z.array(text).min(1);

const replyToComment = z.object({
  type: z.literal("reply_to_comment"),
  text,
});

const sendDm = z.object({
  type: z.literal("send_dm"),
  text,
});

const collectInput = z.object({
  type: z.literal("collect_input"),
  prompt: text,
  validate: z.literal("email").default("email"),
  saveAs: z.string().regex(/^[a-z][a-z0-9_]*$/i).default("email"),
  timeoutSeconds: z.number().positive().max(7 * 86_400).default(86_400),
  maxReprompts: z.number().int().min(0).max(10).default(3),
  /** Per-automation copy that replaces the built-in phrasings for a category. */
  copy: z
    .object({
      typo: phrasings,
      question: phrasings,
      media: phrasings,
      other: phrasings,
      declined: phrasings,
      signOff: phrasings,
    })
    .partial()
    .optional(),
});

const stepSchema = z.discriminatedUnion("type", [replyToComment, sendDm, collectInput]);

export const definitionSchema = z.object({
  trigger: z.object({
    type: z.literal("comment_keyword"),
    keywords: z.array(z.string().trim().min(1).max(100)).min(1),
    postIds: z.array(z.string().min(1)).nullable().default(null),
  }),
  steps: z.array(stepSchema).min(1).max(20),
});

export type Definition = z.infer<typeof definitionSchema>;
export type Step = z.infer<typeof stepSchema>;
export type CollectInputStep = z.infer<typeof collectInput>;
export type CopyCategory = keyof NonNullable<CollectInputStep["copy"]>;

/** `{{name}}` inserts the value as is; `{{name|url}}` encodes it for a URL ("jo+promo@x.io" keeps its "+"). */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*(\|\s*url\s*)?\}\}/g, (_, name: string, url?: string) => {
    const value = vars[name] ?? "";
    return url ? encodeURIComponent(value) : value;
  });
}
