/**
 * Diacritic-stripping NFD normalisation used for case-insensitive,
 * accent-insensitive comparisons against the dictionary.
 *
 * "Joaquín" -> "joaquin", "Søren" -> "soren".
 *
 * We keep the "ø" mapping conservative — combining marks are stripped via
 * NFD, and we additionally apply a small map of Latin-letter substitutions
 * for characters that NFD does not decompose (ø, æ, ð, þ, ß, ı, ł).
 */

const LATIN_SUBSTITUTIONS: ReadonlyArray<[RegExp, string]> = [
  [/ø/g, "o"],
  [/Ø/g, "O"],
  [/æ/g, "ae"],
  [/Æ/g, "AE"],
  [/œ/g, "oe"],
  [/Œ/g, "OE"],
  [/ð/g, "d"],
  [/Ð/g, "D"],
  [/þ/g, "th"],
  [/Þ/g, "Th"],
  [/ß/g, "ss"],
  [/ı/g, "i"],
  [/ł/g, "l"],
  [/Ł/g, "L"],
];

/**
 * Normalise a token for dictionary lookup: NFD decomposition, strip combining
 * marks, apply Latin substitutions, lower-case.
 */
export function normaliseForLookup(input: string): string {
  let out = input.normalize("NFD").replace(/\p{M}/gu, "");
  for (const [pattern, replacement] of LATIN_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.toLowerCase();
}
