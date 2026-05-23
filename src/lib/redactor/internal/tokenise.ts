/**
 * Unicode-aware tokeniser for the redactor's second pass.
 *
 * Splits a string into a stream of segments where each segment is either:
 *  - a "word" run of letters (any Unicode letter, plus combining marks and
 *    intra-word apostrophes / hyphens), or
 *  - a "non-word" run of everything else (whitespace, punctuation, digits,
 *    emoji, newlines).
 *
 * The tokeniser preserves the original substring for every segment so that
 * the redactor can re-emit non-word segments verbatim, satisfying the
 * "preserves punctuation, spacing, line breaks, emoji" acceptance criterion.
 */

export type Segment = {
  readonly text: string;
  readonly isWord: boolean;
  readonly start: number;
};

// A word is a run of one or more letters / combining marks, optionally
// containing single internal apostrophes or hyphens (e.g. "O'Brien",
// "Anne-Marie"). We do not include digits inside words — "April3" splits
// at the boundary, which is fine for our purposes (the "April" half is
// still flagged by the NER pass).
const WORD_REGEX = /[\p{L}\p{M}]+(?:[''\-][\p{L}\p{M}]+)*/gu;

export function tokenise(input: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const match of input.matchAll(WORD_REGEX)) {
    const start = match.index;
    if (start > cursor) {
      segments.push({
        text: input.slice(cursor, start),
        isWord: false,
        start: cursor,
      });
    }
    segments.push({ text: match[0], isWord: true, start });
    cursor = start + match[0].length;
  }

  if (cursor < input.length) {
    segments.push({
      text: input.slice(cursor),
      isWord: false,
      start: cursor,
    });
  }

  return segments;
}
