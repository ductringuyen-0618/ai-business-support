/**
 * Redactor — strips Reviewer identifiers from Review text before any LLM call.
 *
 * This is the single chokepoint enforcing the privacy brake in ADR-0006:
 * Reviewer display names and any other free-text personal-name matches are
 * replaced with the literal `[REVIEWER]` token. The Classifier (ADR-0004),
 * DigestComposer, and any future LLM-bound code path MUST funnel Review text
 * through `redact()` first.
 *
 * Design: pure function, no I/O, no side effects, no globals. Same input →
 * same output. Conservative bias — over-redaction is acceptable; the failure
 * mode we care about is under-redaction.
 *
 * Two passes:
 *   1. Known names — every entry of `knownNames` is replaced
 *      case-insensitively with word-boundary awareness (so "Jim" does not
 *      match inside "Jiminy").
 *   2. NER lite — every capitalised token in the remaining text is checked
 *      against a curated common-first-names dictionary; matches are
 *      replaced. A small heuristic suppresses month-name false positives
 *      ("in April", "on April 3rd") for the four month-names that overlap
 *      with first names: April, May, June, July.
 *
 * See `README.md` in this directory for the contract and how to extend.
 */

import { COMMON_FIRST_NAMES } from "./dictionary";
import { normaliseForLookup } from "./internal/normalize";
import { tokenise, type Segment } from "./internal/tokenise";

export const REDACTION_TOKEN = "[REVIEWER]";

const DICTIONARY: ReadonlySet<string> = new Set(
  COMMON_FIRST_NAMES.map((name) => normaliseForLookup(name)),
);

/**
 * Month-name first-names. We avoid redacting these when they appear after
 * date prepositions / immediately before a day-of-month number, because the
 * month sense dominates in practice. We still redact them when used as
 * names with no date context.
 */
const MONTH_NAME_FIRST_NAMES: ReadonlySet<string> = new Set(["april", "may", "june", "july"]);

/**
 * Common English words / auxiliaries / modals that the dictionary also
 * contains as first names. When capitalised at sentence start (or anywhere
 * else), these read overwhelmingly as the common-noun / verb sense — the
 * false-positive cost outweighs the rare missed redaction. Add sparingly
 * and only after seeing a real false positive.
 *
 * If a Reviewer is genuinely called "Will", the `knownNames` pass-1
 * still catches them once their display name is known. Pass-2 is a
 * best-effort scrubber for incidental first-name mentions; it is
 * acceptable for it to miss tokens that are common English words.
 */
const NEVER_REDACT_TOKENS: ReadonlySet<string> = new Set([
  "will", // auxiliary verb / noun ("will not return")
  "mark", // verb / noun ("mark your spot")
  "rose", // verb past tense / flower ("the temperature rose")
  "summer", // season
  "winter", // season
  "autumn", // season
  "dawn", // noun ("dawn broke")
  "grace", // noun ("with grace")
  "hope", // noun / verb ("we hope")
  "faith", // noun ("had faith")
  "joy", // noun ("filled with joy")
  "patience", // noun
  "art", // noun
  "drew", // verb past tense ("we drew up plans")
  "max", // adjective / noun ("max capacity")
  "pat", // verb ("pat on the back")
  "page", // noun / verb
  "sunday", // day-of-week
]);

const DATE_PREPOSITIONS: ReadonlySet<string> = new Set([
  "in",
  "on",
  "by",
  "since",
  "until",
  "till",
  "before",
  "after",
  "during",
  "around",
  "through",
  "throughout",
  "from",
  "between",
]);

/**
 * The Redactor's public API. See module docstring for semantics.
 *
 * @param text - the Review text (or any LLM-bound user content)
 * @param knownNames - Reviewer display names and any per-Review identifiers
 *                     to scrub. Empty array is fine.
 * @returns the text with every recognised name replaced by [REVIEWER].
 */
export function redact(text: string, knownNames: readonly string[]): string {
  if (text.length === 0) return text;

  // Pass 1: known names (literal, case-insensitive, word-boundary aware).
  let working = redactKnownNames(text, knownNames);

  // Pass 2: NER-lite over a tokenised view of the post-pass-1 text.
  working = redactDictionaryHits(working);

  return working;
}

// --- Pass 1 ---------------------------------------------------------------

function redactKnownNames(text: string, knownNames: readonly string[]): string {
  if (knownNames.length === 0) return text;

  // De-dupe / strip blanks, keep longest first so "Anne Marie" wins over "Anne".
  const cleaned = Array.from(
    new Set(knownNames.map((n) => n.trim()).filter((n) => n.length > 0)),
  ).sort((a, b) => b.length - a.length);

  if (cleaned.length === 0) return text;

  // Build a single Unicode-aware, case-insensitive alternation. We can't use
  // the literal \b assertion for the start/end because \b is ASCII-only when
  // combined with Unicode-letter content; we use look-arounds instead.
  const escaped = cleaned.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])(?:${escaped})(?![\\p{L}\\p{M}\\p{N}])`,
    "giu",
  );

  return text.replace(pattern, REDACTION_TOKEN);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Pass 2 ---------------------------------------------------------------

function redactDictionaryHits(text: string): string {
  const segments = tokenise(text);
  const out: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.isWord) {
      out.push(seg.text);
      continue;
    }

    if (!isCapitalised(seg.text)) {
      out.push(seg.text);
      continue;
    }

    const lookup = normaliseForLookup(seg.text);
    if (!DICTIONARY.has(lookup)) {
      out.push(seg.text);
      continue;
    }

    if (NEVER_REDACT_TOKENS.has(lookup)) {
      out.push(seg.text);
      continue;
    }

    // Don't re-redact something that's already been replaced by pass 1.
    // (Pass-1 emits the literal "[REVIEWER]" which is not a single word
    // segment under our tokeniser — it's "[", "REVIEWER", "]" — but be
    // defensive in case future passes change that.)
    if (seg.text === "REVIEWER") {
      out.push(seg.text);
      continue;
    }

    if (MONTH_NAME_FIRST_NAMES.has(lookup) && looksLikeMonthUsage(text, segments, i)) {
      out.push(seg.text);
      continue;
    }

    out.push(REDACTION_TOKEN);
  }

  return out.join("");
}

function isCapitalised(word: string): boolean {
  // Unicode-aware "starts with an uppercase letter". Single-letter words
  // (e.g. "A", "I") count as capitalised but won't hit the dictionary.
  const first = word.codePointAt(0);
  if (first === undefined) return false;
  const ch = String.fromCodePoint(first);
  return ch === ch.toUpperCase() && ch !== ch.toLowerCase();
}

/**
 * Heuristic: a month-overlap name (April, May, June, July) reads as a
 * month rather than a person when it is preceded by a date preposition
 * ("in April", "on June") OR immediately followed by a day-of-month
 * number ("April 3", "April 3rd", "April 14, 2026"). When in doubt we
 * fall back to redacting — under-redaction is the failure mode.
 */
function looksLikeMonthUsage(text: string, segments: readonly Segment[], index: number): boolean {
  const prevWord = findPreviousWord(segments, index);
  if (prevWord && DATE_PREPOSITIONS.has(prevWord.toLowerCase())) {
    return true;
  }

  const seg = segments[index];
  const afterStart = seg.start + seg.text.length;
  const tail = text.slice(afterStart);
  // " 3", " 3rd", " 14,", " 14th 2026" — whitespace then 1-2 digits then
  // optional ordinal suffix then a word-boundary (digit-side).
  if (/^\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(tail)) {
    return true;
  }

  return false;
}

function findPreviousWord(segments: readonly Segment[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    if (segments[i].isWord) return segments[i].text;
  }
  return null;
}
