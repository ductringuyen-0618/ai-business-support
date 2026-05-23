/**
 * Runtime-validated shape of a Classifier output.
 *
 * The Theme set, Sentiment trio, and Severity scale are taken from CONTEXT.md
 * verbatim — do not invent new values here. Severity is `null` exactly when
 * `is_incident === false`; the Zod refinement below enforces that invariant.
 *
 * Per ADR-0004 a single LLM call returns every per-Review classification, so
 * this schema is the contract for the entire output of `classify()`.
 */
import { z } from "zod";

/**
 * Fixed top-level Theme taxonomy from CONTEXT.md. LLM-generated free-text
 * sub-tags are deferred to a later slice; the top-level set is what the
 * dashboard groups, charts and filters by.
 */
export const THEMES = [
  "service",
  "product_quality",
  "cleanliness",
  "wait_time",
  "pricing",
  "staff_attitude",
  "accessibility",
  "other",
] as const;

export type Theme = (typeof THEMES)[number];

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const SEVERITIES = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const themeSchema = z.enum(THEMES);
export const sentimentSchema = z.enum(SENTIMENTS);
export const severitySchema = z.enum(SEVERITIES);

/**
 * The shape every prompt version must conform to. If a v2 prompt adds a field
 * we extend this — repurposing a field is a breaking change (ADR-0004).
 */
export const classificationSchema = z
  .object({
    is_incident: z.boolean(),
    severity: severitySchema.nullable(),
    // At least one Theme — the LLM should fall back to `"other"` rather than
    // returning an empty array. We dedupe defensively below.
    themes: z.array(themeSchema).min(1),
    sentiment: sentimentSchema,
    // Hard cap chosen so an Operator can scan and copy-paste a draft Reply
    // without scrolling. The LLM is also told this in the system prompt.
    suggested_reply: z.string().min(1).max(500),
    prompt_version: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.is_incident && value.severity === null) {
      ctx.addIssue({
        code: "custom",
        path: ["severity"],
        message: "severity must be set when is_incident is true",
      });
    }
    if (!value.is_incident && value.severity !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["severity"],
        message: "severity must be null when is_incident is false",
      });
    }
  });

export type Classification = z.infer<typeof classificationSchema>;

/**
 * Input to `classify()`. `redactedText` is the contract surface — callers
 * MUST run `Redactor` first (see ADR-0006). We trust the caller here rather
 * than belt-and-braces re-redacting inside the Classifier.
 */
export interface ClassifierInput {
  /** Review body with Reviewer name + first-name-like tokens replaced by `[REVIEWER]`. */
  redactedText: string;
  /** 1–5 inclusive on every Source we support. */
  starRating: number;
  /** When the Reviewer posted on the Source; ISO string or Date. */
  postedAt: Date | string;
  businessProfile: {
    name: string;
    industry?: string;
  };
}
