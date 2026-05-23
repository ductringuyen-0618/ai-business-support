# Redactor

Pure-function module that strips Reviewer identifiers from Review text before
any LLM call. This is the chokepoint enforcing the privacy brake in
[ADR-0006](../../../docs/adr/0006-pii-redact-before-llm-full-storage.md) — the
Classifier ([ADR-0004](../../../docs/adr/0004-single-llm-call-at-review-ingest.md)),
DigestComposer, and any future LLM-bound code path MUST funnel Review text
through `redact()` first. The PRD safety rule "all LLM-bound text must pass
through Redactor" lives here.

## Signature

```ts
import { redact, REDACTION_TOKEN } from "@/lib/redactor";

const redacted: string = redact(text, knownNames);
// REDACTION_TOKEN === "[REVIEWER]"
```

- `text: string` — the Review body (or any other LLM-bound user content).
- `knownNames: readonly string[]` — the Reviewer's display name plus any
  per-Review identifiers known at ingest time (Source-handle aliases, name
  components extracted from author fields, etc.). May be empty.
- **Returns** `string` — `text` with every recognised name replaced by
  `[REVIEWER]`.

The function is **pure**: no I/O, no side effects, no globals. Same input →
same output. It does not mutate the `knownNames` array.

## Conservative-bias principle

Over-redaction is acceptable. Under-redaction is the failure mode. ADR-0006
locks this in:

> Wrong-direction misses (a name we fail to redact) are tolerable; over-
> redaction is also tolerable (replacing "Maria" the manager's name doesn't
> hurt classification).

If a heuristic is unsure whether a token is a name or a common word, the
default is to redact. The few documented exceptions (see "April-the-month"
heuristic and `NEVER_REDACT_TOKENS` below) exist only because their
false-positive rate would make the redacted text unreadable.

## How it works

Two sequential passes:

1. **Known names (pass 1).** Every entry of `knownNames` is replaced
   case-insensitively with word-boundary awareness, using a Unicode-aware
   look-around assertion (so `"Jim"` does not match the `Jim` inside
   `Jiminy`). Multi-word names ("Jane Doe") are supported; longer entries
   take precedence over shorter overlapping ones ("Anne Marie" wins over
   "Anne"). Regex meta-characters in names are escaped.

2. **NER-lite dictionary scan (pass 2).** The text is tokenised into a
   stream of word / non-word segments. Each capitalised word is normalised
   (NFD + diacritic stripping + Latin-letter substitutions for ø, æ, ð, þ,
   ß, ı, ł + lower-case) and looked up in `dictionary.ts`, a curated set
   of ~2,000 common English first names sourced from US Social Security
   Administration baby-name data plus broadly recognisable non-Anglo names
   commonly seen in English reviews. Matches become `[REVIEWER]`.

   Two guards apply in pass 2:
   - **Never-redact tokens** (`NEVER_REDACT_TOKENS` in `index.ts`): a small
     allow-list of dictionary entries that are also common English
     words/auxiliaries when capitalised at sentence start ("Will not return",
     "Mark your spot", "Rose to the occasion"). Pass 1 still catches them if
     they're in `knownNames`.
   - **Month-name heuristic** (`MONTH_NAME_FIRST_NAMES`): April, May, June,
     July are preserved when preceded by a date preposition ("in April", "on
     June") OR immediately followed by a day-of-month number ("April 3rd",
     "April 14, 2026"). In all other contexts they read as names and are
     redacted.

Non-name content — punctuation, spacing, line breaks, emoji, CRLF, digits — is
preserved verbatim.

## Caller contract

**Every code path that sends Review text to Anthropic MUST call `redact()`
first.** There is no opt-out. The `text` parameter into the LLM client should
be the return value of `redact()`, not the raw Review body. This invariant is
not enforced by the type system — reviewers and CI lint rules are the brake.

The redactor is intentionally a free function, not a class or service, so it
can be unit-tested without mocks and called inline from any worker, route, or
job handler without dependency-injection ceremony.

## Adding to the dictionary

1. Open `dictionary.ts`.
2. Append the **lower-case, NFD-normalised, diacritic-stripped** form of the
   name to `COMMON_FIRST_NAMES`. (Example: to add "Søren", append `"soren"`.
   The lookup pipeline normalises input text the same way before matching.)
3. If the new entry is also a common English word that should NOT be
   redacted, add it to `NEVER_REDACT_TOKENS` in `index.ts` with a comment.
4. If the new entry overlaps with a month or day name, extend
   `MONTH_NAME_FIRST_NAMES` and update the heuristic test fixtures.
5. Add a unit test that exercises the new entry, both in isolation and in a
   plausible Review sentence.

The dictionary is committed to the repo, not fetched at runtime — the
redactor is a pure function and has no I/O budget.

## Fixtures

Realistic redacted/unredacted Review pairs live in `__fixtures__/cases.ts`.
Downstream modules (Classifier, DigestComposer) can import `FIXTURES` to
exercise their own LLM-bound paths against the same inputs without
reinventing test data. New cases should round-trip through the redactor's
own test suite.

## Performance

A 10k-character Review redacts in well under 100ms on a modern laptop
(see the "very long input" unit test, which fails CI if the budget is
breached).
