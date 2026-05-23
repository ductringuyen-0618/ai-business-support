/**
 * PlaybookSelector — pure function that filters the Playbook to candidate
 * Patterns for a given week of classified Reviews + a Business profile.
 *
 * This is intentionally a wide net (recall, not precision). The Digest LLM
 * call in slice 14 receives these candidates and picks the final top 3,
 * rewriting each with specifics quoted from the actual Reviews.
 *
 * Filter rules:
 *   1. Pattern.themes overlaps with the union of Themes across the week's
 *      Reviews.
 *   2. Pattern.verticals is absent / empty OR includes business.industry.
 *
 * If there are no Reviews this week, the selector returns []. ADR-0008
 * states "A Business with 0 Reviews in the week skips the Digest entirely",
 * and an empty candidate set is the explicit signal of that.
 *
 * No I/O, no LLM call. Safe to run in any context.
 */

import { PLAYBOOK, type Pattern, type Theme } from "./playbook";

export interface ClassifiedReview {
  themes: Theme[];
  sentiment: "positive" | "neutral" | "negative";
  // Other fields (id, body, rating, ...) may be present on the real type
  // produced by the Classifier. The selector intentionally ignores them.
}

export interface BusinessProfile {
  name: string;
  /** Industry slug, matched against Pattern.verticals. Case-insensitive. */
  industry?: string;
}

export interface SelectCandidatesInput {
  reviews: ClassifiedReview[];
  business: BusinessProfile;
}

/**
 * Return all Patterns whose `themes` overlap with the week's Themes and
 * whose `verticals` (if set) match the Business's industry. Order matches
 * the declaration order in `playbook.ts` so output is deterministic.
 */
export function selectCandidates(input: SelectCandidatesInput): Pattern[] {
  const { reviews, business } = input;

  // 0-Review week → empty candidate set. Digest is skipped upstream.
  if (reviews.length === 0) {
    return [];
  }

  const weekThemes = unionOfThemes(reviews);
  if (weekThemes.size === 0) {
    return [];
  }

  const industry = business.industry?.trim().toLowerCase();

  return PLAYBOOK.filter((pattern) => {
    if (!themesOverlap(pattern.themes, weekThemes)) {
      return false;
    }
    if (!verticalMatches(pattern.verticals, industry)) {
      return false;
    }
    return true;
  });
}

function unionOfThemes(reviews: readonly ClassifiedReview[]): Set<Theme> {
  const set = new Set<Theme>();
  for (const review of reviews) {
    for (const theme of review.themes) {
      set.add(theme);
    }
  }
  return set;
}

function themesOverlap(patternThemes: readonly Theme[], weekThemes: Set<Theme>): boolean {
  for (const theme of patternThemes) {
    if (weekThemes.has(theme)) {
      return true;
    }
  }
  return false;
}

function verticalMatches(
  verticals: readonly string[] | undefined,
  industry: string | undefined,
): boolean {
  // Universal Pattern (no verticals listed) matches any Business.
  if (!verticals || verticals.length === 0) {
    return true;
  }
  // Pattern is vertical-restricted but Business has no industry → exclude.
  if (!industry) {
    return false;
  }
  return verticals.some((v) => v.trim().toLowerCase() === industry);
}
