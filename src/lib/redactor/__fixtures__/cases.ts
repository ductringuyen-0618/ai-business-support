/**
 * Realistic redacted/unredacted Review pairs used by both the Redactor's
 * own unit tests and (eventually) by downstream modules (Classifier,
 * DigestComposer) that want to exercise their LLM-bound code paths against
 * realistic inputs without re-inventing fixtures.
 *
 * Each case captures: a short label, the raw Review text as it would appear
 * on a Source, the `knownNames` slice that would be supplied alongside it,
 * and the expected output of `redact()`. The expected outputs are written
 * by hand from the contract (not snapshotted) so changes to redactor
 * heuristics show up as test diffs to inspect, not silent re-snapshots.
 */

export type RedactionCase = {
  readonly name: string;
  readonly input: string;
  readonly knownNames: readonly string[];
  readonly expected: string;
};

export const FIXTURES: readonly RedactionCase[] = [
  {
    name: "display-name-only",
    input: "Great visit, the team was friendly and quick. -JaneD",
    knownNames: ["JaneD"],
    expected: "Great visit, the team was friendly and quick. -[REVIEWER]",
  },
  {
    name: "display-name-plus-free-text-first-name",
    input: "JaneD here. Sarah at the front desk was incredibly helpful with my booking.",
    knownNames: ["JaneD"],
    expected:
      "[REVIEWER] here. [REVIEWER] at the front desk was incredibly helpful with my booking.",
  },
  {
    name: "multiple-reviewer-names-in-one-review",
    input:
      "Posted by Jane Doe (aka JaneD). I came in with my partner Tom and we both had a great time.",
    knownNames: ["Jane Doe", "JaneD", "Tom"],
    expected:
      "Posted by [REVIEWER] (aka [REVIEWER]). I came in with my partner [REVIEWER] and we both had a great time.",
  },
  {
    name: "accented-names",
    input: "Joaquín and Søren were our servers. Both deserve a raise!",
    knownNames: [],
    expected: "[REVIEWER] and [REVIEWER] were our servers. Both deserve a raise!",
  },
  {
    name: "april-month-vs-april-person",
    input: "We visited in April and it was packed. Our server April was patient with us though.",
    knownNames: [],
    expected:
      "We visited in April and it was packed. Our server [REVIEWER] was patient with us though.",
  },
  {
    name: "zero-name-review-no-op",
    input: "The wait was 45 minutes. Food was lukewarm. Will not return.",
    knownNames: [],
    expected: "The wait was 45 minutes. Food was lukewarm. Will not return.",
  },
  {
    name: "empty-string",
    input: "",
    knownNames: ["JaneD"],
    expected: "",
  },
];
