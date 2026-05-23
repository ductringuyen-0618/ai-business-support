/**
 * DigestComposer — the single LLM call that produces the weekly Digest body
 * (slice 14, ADR-0008).
 *
 * Pipeline (in order — do NOT reorder; this is the contract from issue #16):
 *
 *   1. Run `selectCandidates()` to narrow the Playbook to candidates that
 *      match the week's Themes + the Business's vertical. Pure filter.
 *   2. Pick 3–5 representative redacted Review quotes per dominant Theme.
 *   3. Build the user message with: candidate Patterns, Theme aggregates +
 *      deltas, redacted quotes, Business profile.
 *   4. Call Anthropic ONCE with prompt caching on the stable system block.
 *   5. Parse + validate the structured JSON via Zod. On Zod failure, retry
 *      ONCE with stricter framing. Second failure throws.
 *
 * Post-parse validation defends against the LLM hallucinating:
 *   - `topPatterns.length === 3` exactly.
 *   - Each `patternId` MUST come from the candidate Pattern set.
 *   - Each `evidence.redactedQuote` MUST appear in the input quotes (dropped
 *     defensively if it doesn't — never trust an LLM-produced quote).
 *   - `overallTone === "celebrate"` ⇒ all 3 Patterns must be `kind=reinforcement`.
 *
 * The composer NEVER touches the database. The cron handler owns I/O.
 */
import { z } from "zod";

import {
  type AnthropicCreateParams,
  type AnthropicCreateResponse,
  type AnthropicMessageClient,
  getDefaultDigestClient,
  resolveDigestModel,
} from "./anthropic-client";
import type {
  CandidatePromptPattern,
  ClassifiedReview,
  DigestBody,
  ReviewExcerpt,
  ReviewQuote,
  ThemeAggregate,
} from "./composer-types";
import type { Pattern, Theme } from "./playbook";
import { selectCandidates } from "./playbook-selector";
import { PROMPT_VERSION, RETRY_INSTRUCTION, SYSTEM_PROMPT, buildUserMessage } from "./prompts/v1";

export type {
  ClassifiedReview,
  DigestBody,
  ReviewExcerpt,
  ReviewQuote,
  ThemeAggregate,
} from "./composer-types";
export { PROMPT_VERSION } from "./prompts/v1";

/** Internal cap. Output is a small JSON object; 2048 is comfortable. */
const MAX_TOKENS = 2048;

/** Max evidence quotes per Pattern (the LLM is told 1–3; we drop extras). */
const MAX_EVIDENCE_PER_PATTERN = 3;

/** Max redacted quotes per Theme handed to the LLM as evidence material. */
const MAX_QUOTES_PER_THEME = 5;
const MIN_QUOTES_PER_THEME = 3;

export interface ComposeDigestInput {
  reviews: ClassifiedReview[];
  business: { id: string; name: string; industry?: string };
  playbook: readonly Pattern[];
  /**
   * Per-Theme counts for the current 7-day window and the previous 7-day
   * window. The cron handler computes this; the composer just plumbs it
   * through to the LLM prompt and the structured output.
   */
  weekOverWeekTheme: Partial<Record<Theme, { current: number; previous: number }>>;
  now: Date;
}

export interface ComposerDeps {
  client?: AnthropicMessageClient;
  model?: string;
}

/**
 * Thrown when the composer cannot produce a valid Digest body after the single
 * retry. The cron handler catches this and lets pg-boss retry the job; we do
 * NOT persist a partial Digest row.
 */
export class DigestComposerError extends Error {
  readonly firstAttempt: string;
  readonly secondAttempt: string;
  readonly lastRawText: string;
  constructor(
    message: string,
    details: { firstAttempt: string; secondAttempt: string; lastRawText: string },
  ) {
    super(message);
    this.name = "DigestComposerError";
    this.firstAttempt = details.firstAttempt;
    this.secondAttempt = details.secondAttempt;
    this.lastRawText = details.lastRawText;
  }
}

const digestBodySchema = z.object({
  themeMovement: z.array(
    z.object({
      theme: z.string().min(1),
      delta: z.number().int(),
      direction: z.enum(["up", "down", "flat"]),
    }),
  ),
  topPatterns: z
    .array(
      z.object({
        patternId: z.string().min(1),
        title: z.string().min(1),
        tailoredBody: z.string().min(1),
        evidence: z
          .array(
            z.object({
              reviewId: z.string().min(1),
              starRating: z.number().int().min(1).max(5),
              redactedQuote: z.string().min(1),
              themes: z.array(z.string()).min(1),
            }),
          )
          .min(1),
      }),
    )
    .length(3),
  overallTone: z.enum(["celebrate", "neutral", "concerning"]),
});

type RawDigestBody = z.infer<typeof digestBodySchema>;

export async function composeDigest(
  input: ComposeDigestInput,
  deps: ComposerDeps = {},
): Promise<DigestBody> {
  // 1. Candidate filter — pure function from slice 7.
  const candidates = selectCandidates({
    reviews: input.reviews,
    business: { name: input.business.name, industry: input.business.industry },
  });

  if (candidates.length < 3) {
    // ADR-0008: "the candidate list was pre-filtered for relevance" — but if we
    // can't even hit 3 candidates, the LLM cannot satisfy the `length === 3`
    // contract. The cron handler catches this and skips the Digest with a
    // warning rather than producing a malformed row.
    throw new DigestComposerError(
      `composeDigest: only ${candidates.length} candidate Patterns available; need at least 3`,
      {
        firstAttempt: "",
        secondAttempt: "",
        lastRawText: "",
      },
    );
  }

  const candidateIds = new Set(candidates.map((c) => c.id));
  const reinforcementIds = new Set(
    candidates.filter((c) => c.kind === "reinforcement").map((c) => c.id),
  );

  // 2. Pick redacted quotes — 3-5 per dominant Theme, ordered by recency.
  const quotes = pickQuotes(input.reviews);
  const quotesByText = new Map(quotes.map((q) => [q.redactedQuote, q] as const));

  // 3. Build the user message.
  const themeAggregates = buildThemeAggregates(input.weekOverWeekTheme);
  const promptCandidates: CandidatePromptPattern[] = candidates.map((c) => ({
    id: c.id,
    themes: [...c.themes],
    verticals: c.verticals ? [...c.verticals] : undefined,
    kind: c.kind,
    title: c.title,
    body: c.body,
    signals: c.signals,
  }));

  const userMessage = buildUserMessage({
    business: { name: input.business.name, industry: input.business.industry },
    candidates: promptCandidates,
    themeAggregates,
    quotes,
  });

  const client = deps.client ?? getDefaultDigestClient();
  const model = deps.model ?? resolveDigestModel();

  // 4. First attempt.
  const firstRaw = await callAnthropic(client, model, userMessage);
  const firstParsed = tryParseAndValidate(firstRaw, {
    candidateIds,
    reinforcementIds,
    quotesByText,
  });
  if (firstParsed.ok) return firstParsed.value;

  // 5. Single retry with stricter framing.
  const secondRaw = await callAnthropic(client, model, `${userMessage}\n\n${RETRY_INSTRUCTION}`);
  const secondParsed = tryParseAndValidate(secondRaw, {
    candidateIds,
    reinforcementIds,
    quotesByText,
  });
  if (secondParsed.ok) return secondParsed.value;

  throw new DigestComposerError("DigestComposer produced invalid output twice in a row", {
    firstAttempt: firstParsed.error,
    secondAttempt: secondParsed.error,
    lastRawText: secondRaw,
  });
}

async function callAnthropic(
  client: AnthropicMessageClient,
  model: string,
  userMessage: string,
): Promise<string> {
  const params: AnthropicCreateParams = {
    model,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Cache the stable system block. Every Business's Monday Digest run
        // hits cache read-cost rather than write-cost on this prefix.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  };
  const response = await client.create(params);
  return extractText(response);
}

function extractText(response: AnthropicCreateResponse): string {
  return response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

interface ValidationContext {
  candidateIds: Set<string>;
  reinforcementIds: Set<string>;
  quotesByText: Map<string, ReviewQuote>;
}

type ParseResult = { ok: true; value: DigestBody } | { ok: false; error: string };

/**
 * Pull the JSON payload out, run Zod, then run post-parse semantic checks
 * (candidate-id whitelist, reinforcement constraint on celebrate tone, drop
 * evidence quotes that don't appear in the input).
 */
function tryParseAndValidate(rawText: string, ctx: ValidationContext): ParseResult {
  const json = extractJsonPayload(rawText);
  if (json === null) return { ok: false, error: "no JSON payload found in LLM response" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      error: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const schemaResult = digestBodySchema.safeParse(parsedJson);
  if (!schemaResult.success) {
    return {
      ok: false,
      error: schemaResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  // Post-parse semantic checks. These mirror the constraints stated in the
  // system prompt; we re-enforce them because the LLM can hallucinate even
  // when the JSON shape is fine.
  const sanitised = sanitise(schemaResult.data, ctx);
  if (!sanitised.ok) return sanitised;
  return sanitised;
}

function sanitise(raw: RawDigestBody, ctx: ValidationContext): ParseResult {
  // 1. patternIds must all come from the candidate set. We do not "fix" this
  // by dropping unknown ids — the contract is exactly 3 distinct patternIds
  // from the candidate set, and a hallucinated id is treated as an LLM error
  // worth a retry (better catch on a retry than ship a broken Digest).
  const seenIds = new Set<string>();
  for (const p of raw.topPatterns) {
    if (!ctx.candidateIds.has(p.patternId)) {
      return { ok: false, error: `topPatterns[].patternId "${p.patternId}" not in candidate set` };
    }
    if (seenIds.has(p.patternId)) {
      return { ok: false, error: `topPatterns[].patternId "${p.patternId}" appears twice` };
    }
    seenIds.add(p.patternId);
  }

  // 2. Celebrate-tone constraint per ADR-0008.
  if (raw.overallTone === "celebrate") {
    for (const p of raw.topPatterns) {
      if (!ctx.reinforcementIds.has(p.patternId)) {
        return {
          ok: false,
          error: `overallTone="celebrate" requires all Patterns to be kind=reinforcement; "${p.patternId}" is not`,
        };
      }
    }
  }

  // 3. Drop evidence quotes the LLM made up. Each Pattern still needs at
  // least one verified quote — if all are dropped, that's a retry.
  const sanitisedPatterns: DigestBody["topPatterns"] = [];
  for (const p of raw.topPatterns) {
    const verifiedEvidence: ReviewExcerpt[] = [];
    for (const e of p.evidence) {
      const match = ctx.quotesByText.get(e.redactedQuote);
      if (!match) continue;
      // Use the canonical reviewId/themes from the input rather than what the
      // LLM emitted — defends against the LLM correctly quoting the text but
      // mis-attributing it to a different review id.
      verifiedEvidence.push({
        reviewId: match.reviewId,
        starRating: match.starRating,
        redactedQuote: match.redactedQuote,
        themes: [...match.themes],
      });
      if (verifiedEvidence.length >= MAX_EVIDENCE_PER_PATTERN) break;
    }
    if (verifiedEvidence.length === 0) {
      return {
        ok: false,
        error: `topPatterns[].evidence for patternId "${p.patternId}" contained no quotes that match input`,
      };
    }
    sanitisedPatterns.push({
      patternId: p.patternId,
      title: p.title,
      tailoredBody: p.tailoredBody,
      evidence: verifiedEvidence,
    });
  }

  // 4. themeMovement passes through with a Theme-narrowing cast — Zod already
  // checked the direction enum; we widen direction's type by re-asserting.
  return {
    ok: true,
    value: {
      themeMovement: raw.themeMovement.map((m) => ({
        theme: m.theme as Theme,
        delta: m.delta,
        direction: m.direction,
      })),
      topPatterns: sanitisedPatterns,
      overallTone: raw.overallTone,
    },
  };
}

function extractJsonPayload(rawText: string): string | null {
  const outputMatch = rawText.match(/<output>([\s\S]*?)<\/output>/i);
  if (outputMatch) return outputMatch[1].trim();

  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();

  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return rawText.slice(firstBrace, lastBrace + 1).trim();
  }
  return null;
}

/**
 * Pick 3–5 redacted quotes per dominant Theme, ordered by recency (newest
 * first within each Theme). De-duplicates across Themes so the same Review
 * doesn't appear twice in the prompt.
 */
function pickQuotes(reviews: readonly ClassifiedReview[]): ReviewQuote[] {
  // Count Themes to decide what "dominant" means for this week.
  const themeCounts = new Map<Theme, number>();
  for (const r of reviews) {
    for (const t of r.themes) {
      themeCounts.set(t, (themeCounts.get(t) ?? 0) + 1);
    }
  }
  // Sort Themes by frequency desc, tiebreak alphabetically for determinism.
  const orderedThemes = [...themeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);

  // Build review-by-theme index, ordered by recency desc.
  const byTheme = new Map<Theme, ClassifiedReview[]>();
  const sortedReviews = [...reviews].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
  for (const r of sortedReviews) {
    for (const t of r.themes) {
      if (!byTheme.has(t)) byTheme.set(t, []);
      byTheme.get(t)!.push(r);
    }
  }

  const picked = new Map<string, ReviewQuote>();
  for (const theme of orderedThemes) {
    const candidates = byTheme.get(theme) ?? [];
    // Prefer reviews whose redactedText is non-empty — a star-only Review
    // (empty redacted text) doesn't make for useful evidence.
    const usable = candidates.filter((r) => r.redactedText.trim().length > 0);
    let added = 0;
    for (const r of usable) {
      if (picked.has(r.id)) continue;
      picked.set(r.id, {
        reviewId: r.id,
        starRating: r.starRating,
        redactedQuote: r.redactedText,
        themes: [...r.themes],
      });
      added += 1;
      if (added >= MAX_QUOTES_PER_THEME) break;
    }
    // Note: we intentionally DON'T pad — if a Theme has fewer than
    // MIN_QUOTES_PER_THEME usable Reviews, we still proceed with what we
    // have. The LLM gets less evidence for that Theme; that's accurate.
    void MIN_QUOTES_PER_THEME;
  }

  return [...picked.values()];
}

function buildThemeAggregates(
  weekOverWeek: Partial<Record<Theme, { current: number; previous: number }>>,
): ThemeAggregate[] {
  const out: ThemeAggregate[] = [];
  for (const [theme, counts] of Object.entries(weekOverWeek) as Array<
    [Theme, { current: number; previous: number }]
  >) {
    if (!counts) continue;
    if (counts.current === 0 && counts.previous === 0) continue;
    out.push({ theme, current: counts.current, previous: counts.previous });
  }
  // Deterministic ordering — Theme alphabetical.
  out.sort((a, b) => a.theme.localeCompare(b.theme));
  return out;
}
