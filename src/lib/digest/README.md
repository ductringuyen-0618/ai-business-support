# `src/lib/digest` — Playbook + PlaybookSelector

This module owns the seed **Playbook** catalogue (`playbook.ts`) and the pure
**PlaybookSelector** (`playbook-selector.ts`) consumed by the weekly **Digest**
LLM call (slice 14). Background, rationale, and the `Pattern` shape are in
[`docs/adr/0008-playbook-backed-digest-suggestions.md`](../../../docs/adr/0008-playbook-backed-digest-suggestions.md).

## What lives here

| File                        | Responsibility                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `playbook.ts`               | The curated catalogue: ~45 Patterns, typed `as const satisfies readonly Pattern[]`. Source of truth.           |
| `playbook-selector.ts`      | `selectCandidates({ reviews, business })` — pure function returning candidate Patterns for the week's Reviews. |
| `playbook.test.ts`          | Catalogue invariants: per-Theme coverage, reinforcement count, id slugs, vertical coverage.                    |
| `playbook-selector.test.ts` | Filter behaviour: zero-Review week, all-positive week, vertical exclusion, purity, deterministic order.        |

## What does NOT live here

- The LLM call that picks the final top 3 Patterns and rewrites each with
  specifics quoted from actual Reviews — that's slice 14.
- The Digest email template and the cron / queue glue that schedules it.
- Ranking or scoring of candidates. The selector is intentionally a wide
  net (recall, not precision); the Digest LLM does the final selection.

## How to add a Pattern

1. **Open a PR adding the entry to `PLAYBOOK` in `playbook.ts`.** Don't
   skip steps below — the Digest is a load-bearing product artifact.
2. **Pick a stable, slug-style `id`.** Lowercase, hyphen-separated, unique
   in the catalogue. Once shipped, the id is permanent — it gets stored
   inside `digests.body` (JSONB) in slice 14, and renaming would dangle
   historical references.
3. **Use Themes from the fixed set only** (`service`, `product_quality`,
   `cleanliness`, `wait_time`, `pricing`, `staff_attitude`, `accessibility`,
   `other`). The compiler will reject anything else thanks to
   `as const satisfies readonly Pattern[]`.
4. **`verticals` is optional.** Omit it for universal Patterns. If set,
   use lowercase snake_case slugs that match the `Business.industry`
   value the Operator picks at onboarding. Today's seed covers
   `restaurant`, `cafe`, `barbershop`, `salon`, `dentist`, `auto_repair`.
5. **Write a real, specific `title` and `body`.** A short imperative title
   and 1–2 sentences of concrete guidance. The Digest LLM will quote
   actual Reviews around your body text — leave room for it.
6. **Write a sharp `signals` line.** This is what the LLM uses to decide
   whether the week's Reviews match your Pattern. "wait_time mentioned
   3+ times in a single week" — not "when customers complain about
   waits". Concrete > vague.
7. **Pick a `kind`.** `remediation` for negative weeks, `reinforcement`
   for positive weeks where the Pattern celebrates something working.
8. **Run the gate locally** before pushing:
   ```bash
   pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
   ```
9. **Re-run the `evaluate-skill` eval suite** if your change is likely to
   shift Digest output on representative weeks (see below).

## Invariants enforced by tests

`playbook.test.ts` will fail your PR if any of these break:

- Total Pattern count is between 30 and 60.
- Every Theme in the fixed set has **≥3 remediation Patterns**.
- The catalogue has **≥5 reinforcement Patterns** in total.
- At least three vertical-scoped Patterns exist, covering at minimum
  `restaurant` and `barbershop`.
- Every `id` is unique and slug-styled.
- Every Pattern has non-empty `title`, `body`, and `signals`.

Adjust the tests in the same PR only if the contract genuinely needs to
change — and call it out explicitly in the PR description.

## When to re-run the Digest eval suite

The Playbook is a load-bearing product artifact: the Digest LLM in slice
14 selects 3 Patterns from this catalogue every week for every Business.
A bad Pattern silently degrades every Digest until it's caught.

Per ADR-0008, the
[`evaluate-skill`](../../../.claude/skills/evaluate-skill/SKILL.md)
methodology should be run on a fixed set of synthetic Digest scenarios
when the Playbook changes. The eval suite itself lands in slice 14 (it
needs the Digest LLM call to exist). Until then:

- **For Pattern _additions_** that don't overlap existing Themes /
  verticals strongly: low risk, ship the PR with a note.
- **For Pattern _edits or removals_** of existing entries: high risk —
  the new wording can change which Pattern the LLM picks on every
  historical scenario. Wait for slice 14's eval suite to land, or run a
  manual spot-check against representative weeks.
- **For changes to the Theme set or `Pattern` shape itself**: requires
  an ADR update first.

The selector itself (`playbook-selector.ts`) is pure and covered by unit
tests — changes there are cheap to validate. Changes to the catalogue's
_content_ are the ones that need the eval suite.

## Slice scope reminder

Slice 7 shipped the data + the pure candidate filter. Slice 14 adds the
LLM-tailoring layer:

| File                      | Owner slice | Responsibility                                                                                                |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `composer.ts`             | 14          | `composeDigest()` — the single LLM call. Selects 3 Patterns + tailors them. Zod-validated + retry-on-failure. |
| `composer-types.ts`       | 14          | `DigestBody` shape persisted in `digests.body` (jsonb). Re-exported from `src/db/schema.ts`.                  |
| `anthropic-client.ts`     | 14          | DI seam mirroring `src/lib/classifier/anthropic-client.ts`. `DIGEST_COMPOSER_MODEL` env override.             |
| `prompts/v1.ts`           | 14          | Stable system prompt (cached via `cache_control: ephemeral`) + dynamic user-message builder + retry framing.  |
| `__fixtures__/anthropic/` | 14          | Recorded Anthropic responses for the composer tests + eval baseline.                                          |
| `evals/`                  | 14          | `evals.json` + `run.ts` + `benchmark.json` — the Layer-2 eval suite per `evaluate-skill`.                     |

The cron + email-send glue lives outside this module: handler at
`src/queue/handlers/compose-digest.ts`, email template at
`src/lib/email/digest-email.ts`.
