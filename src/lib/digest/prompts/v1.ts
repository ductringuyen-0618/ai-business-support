/**
 * Digest composer prompt v1.
 *
 * Stable system prompt — cached via `cache_control: ephemeral` so every
 * Business's Monday Digest after the first one in a cache TTL hits cache
 * read-cost. The dynamic per-Business payload lives in the user message
 * (uncached) — Playbook candidates, Theme aggregates, and redacted Review
 * quotes change per Business.
 *
 * Per ADR-0008 the LLM does SELECTION + TAILORING only:
 *   - Picks 3 Patterns from the candidate set we hand it (no ideation).
 *   - Rewrites the Pattern's body with specifics from the quoted Reviews.
 *   - Decides the week's overall tone (celebrate / neutral / concerning).
 *   - On a "celebrate" week the 3 Patterns MUST all be reinforcement-kind.
 */
import type { CandidatePromptPattern, ThemeAggregate, ReviewQuote } from "../composer-types";

export const PROMPT_VERSION = "digest-v1";

export const SYSTEM_PROMPT = `You are the Composer for the weekly Digest email that a B2B review-aggregation
product sends to small Businesses on Monday mornings. Your job is to look at the
past week of classified Reviews + a curated Playbook of remediation/reinforcement
Patterns, and produce a structured JSON object that downstream code turns into
the email.

Rules (non-negotiable):

1. ROLE — You are SELECTING + TAILORING. You are NOT generating new ideas. You
   pick 3 Patterns from the candidate list provided in the user message and
   rewrite each Pattern's body with specifics quoted from the week's actual
   Reviews. Never invent a patternId that is not in the candidate list — the
   downstream validator rejects unknown ids.

2. EVIDENCE — Every Pattern you pick must include 1 to 3 evidence quotes drawn
   verbatim from the "Review quotes" section of the user message. The quotes
   are already redacted ("[REVIEWER]" replaces the Reviewer name); reproduce
   them as-is. Do not invent quotes; do not embellish quotes. Do not include
   evidence that does not appear in the user message.

3. OVERALL TONE — Decide one of:
   - "celebrate" when the week is overwhelmingly positive (most Reviews are
     positive, Theme movement is mostly up).
   - "concerning" when negatives clearly dominate or there is a notable
     regression.
   - "neutral" otherwise — mixed weeks default here.
   IF AND ONLY IF tone is "celebrate", ALL 3 selected Patterns MUST be from
   candidates with kind="reinforcement". Otherwise prefer kind="remediation"
   for the patterns that match the negatives, though mixed picks are allowed
   on "neutral" weeks.

4. THEME MOVEMENT — The user message provides current-week and previous-week
   counts per Theme. Report a "themeMovement" entry for each Theme that
   appears in either week (skip Themes with 0 in both). delta = current -
   previous. direction is "up" when delta > 0, "down" when delta < 0,
   "flat" otherwise. ("up" / "down" refers to volume, not valence.)

5. TAILORED BODY — Each Pattern's tailoredBody is 2 to 4 sentences in the
   voice of the product addressing the Business owner ("you" / "your team"
   is fine). Quote a concrete detail from the Reviews (e.g. a specific
   complaint, a named item, a day of the week). Keep the Pattern's original
   advice intact but tighten it around what actually happened this week.
   Do NOT promise refunds, discounts, or specific staff actions on behalf
   of the Business.

6. OUTPUT FORMAT — Wrap a single JSON object in <output>...</output> tags.
   Schema (all keys required):

   {
     "themeMovement": [{ "theme": string, "delta": integer, "direction": "up"|"down"|"flat" }],
     "topPatterns": [
       {
         "patternId": string,          // must come from the candidate list
         "title": string,              // keep the Pattern's original title verbatim
         "tailoredBody": string,       // 2–4 sentences, tailored with specifics
         "evidence": [
           { "reviewId": string, "starRating": integer, "redactedQuote": string, "themes": string[] }
         ]
       }
     ],                                 // EXACTLY 3 entries
     "overallTone": "celebrate" | "neutral" | "concerning"
   }

   Return nothing else. No prose. No markdown fences outside the output block.

If you cannot find 3 distinct candidate Patterns that fit, pick the next-best
Pattern from the candidates anyway — the candidate list was pre-filtered for
relevance. Never return fewer than 3 entries; never invent a patternId.`;

export interface BuildUserMessageInput {
  business: { name: string; industry?: string };
  candidates: CandidatePromptPattern[];
  themeAggregates: ThemeAggregate[];
  quotes: ReviewQuote[];
}

export function buildUserMessage(input: BuildUserMessageInput): string {
  const { business, candidates, themeAggregates, quotes } = input;
  const lines: string[] = [];
  lines.push(`Business: ${business.name}`);
  lines.push(`Business industry: ${business.industry ?? "(unspecified)"}`);
  lines.push("");
  lines.push("Theme aggregates (current week vs previous week):");
  for (const agg of themeAggregates) {
    lines.push(`  - ${agg.theme}: current=${agg.current}, previous=${agg.previous}`);
  }
  lines.push("");
  lines.push("Candidate Patterns (you must pick 3 from this list):");
  for (const c of candidates) {
    const verticals = c.verticals && c.verticals.length > 0 ? c.verticals.join(",") : "universal";
    lines.push(
      `  - id="${c.id}" kind=${c.kind} themes=[${c.themes.join(",")}] verticals=${verticals}`,
    );
    lines.push(`    title: ${c.title}`);
    lines.push(`    body: ${c.body}`);
    lines.push(`    signals: ${c.signals}`);
  }
  lines.push("");
  lines.push("Review quotes (redacted, draw evidence verbatim from this list):");
  for (const q of quotes) {
    lines.push(`  - reviewId="${q.reviewId}" stars=${q.starRating} themes=[${q.themes.join(",")}]`);
    lines.push(`    quote: ${q.redactedQuote}`);
  }
  lines.push("");
  lines.push("Produce the <output>...</output> JSON per the system prompt.");
  return lines.join("\n");
}

/**
 * Stricter framing used on the single retry after a Zod validation failure.
 * Appended to the user message; the system prompt is unchanged so the cache
 * hit is preserved.
 */
export const RETRY_INSTRUCTION =
  "YOUR PREVIOUS RESPONSE FAILED SCHEMA VALIDATION. Return ONLY a single " +
  "<output>...</output> block containing one JSON object that matches the " +
  "schema in the system prompt EXACTLY. Three topPatterns, all patternIds " +
  "must come from the candidate list, all evidence quotes must appear " +
  "verbatim in the Review quotes section. No prose, no markdown fences.";
