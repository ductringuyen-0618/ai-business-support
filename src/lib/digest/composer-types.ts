/**
 * Shared types used by the Digest composer module + its prompt + tests.
 *
 * Kept separate from `composer.ts` so the prompt module (which is loaded into
 * the Anthropic cache key) doesn't pull in zod / SDK transitive deps.
 */
import type { Pattern, Theme } from "./playbook";

/**
 * Classified Review handed to `composeDigest`. Intentionally narrower than the
 * `reviews` DB row + `classifications` DB row — the composer only reads what it
 * needs to build the prompt + the evidence quotes. The handler joins the two
 * tables before calling.
 *
 * `redactedText` is the ONLY text shape the composer sees — raw review_text
 * never crosses this boundary (ADR-0006).
 */
export interface ClassifiedReview {
  id: string;
  starRating: number;
  redactedText: string;
  postedAt: Date;
  themes: Theme[];
  sentiment: "positive" | "neutral" | "negative";
}

/**
 * Per-Theme aggregate for the current week + the previous week. Computed by
 * the cron handler before it calls `composeDigest`; the LLM converts this into
 * `themeMovement` entries.
 */
export interface ThemeAggregate {
  theme: Theme;
  current: number;
  previous: number;
}

/** Redacted Review quote handed to the LLM as evidence material. */
export interface ReviewQuote {
  reviewId: string;
  starRating: number;
  redactedQuote: string;
  themes: Theme[];
}

/** Pattern subset embedded in the LLM prompt. */
export interface CandidatePromptPattern {
  id: string;
  themes: Theme[];
  verticals?: string[];
  kind: Pattern["kind"];
  title: string;
  body: string;
  signals: string;
}

/** Single excerpt embedded in a Digest row (matches `DigestBody.topPatterns[*].evidence[*]`). */
export interface ReviewExcerpt {
  reviewId: string;
  starRating: number;
  redactedQuote: string;
  themes: Theme[];
}

/**
 * The structured Digest body — also re-exported from `composer.ts` as the
 * `DigestBody` shape persisted in `digests.body`.
 */
export interface DigestBody {
  themeMovement: Array<{
    theme: Theme;
    delta: number;
    direction: "up" | "down" | "flat";
  }>;
  topPatterns: Array<{
    patternId: string;
    title: string;
    tailoredBody: string;
    evidence: ReviewExcerpt[];
  }>;
  overallTone: "celebrate" | "neutral" | "concerning";
}
