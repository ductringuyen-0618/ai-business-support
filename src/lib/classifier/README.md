# `Classifier` module

The single LLM call per Review ([ADR-0004](../../../docs/adr/0004-single-llm-call-at-review-ingest.md)) that
detects Incidents ([ADR-0002](../../../docs/adr/0002-llm-driven-incident-classification.md)),
tags Themes, scores sentiment, and drafts a Reply ([ADR-0003](../../../docs/adr/0003-llm-drafted-replies-no-auto-post.md))
the Operator copies onto the Source.

## Public API

```ts
import { classify, type Classification } from "@/lib/classifier";

const result: Classification = await classify({
  redactedText, // already-redacted Review text — see contract below
  starRating, // 1–5
  postedAt, // Date | ISO string
  businessProfile: { name, industry },
});
```

`Classification` shape:

```ts
{
  is_incident: boolean;
  severity: "low" | "medium" | "high" | null; // null iff is_incident=false
  themes: Theme[];                            // fixed set, see CONTEXT.md
  sentiment: "positive" | "neutral" | "negative";
  suggested_reply: string;                    // <= 500 chars
  prompt_version: string;                     // e.g. "v1"
}
```

## Pre-redaction contract (READ THIS)

`classify()` trusts that `redactedText` has already been processed by the
`Redactor` module ([ADR-0006](../../../docs/adr/0006-pii-redact-before-llm-full-storage.md)).
Reviewer display names and first-name-like tokens MUST be replaced with the
literal token `[REVIEWER]` before calling. The Classifier does NOT double-redact —
the call chain (the `ingest_review` job, slice 9) is the chokepoint that enforces
this. If you're calling `classify()` from anywhere else, redact first.

## Configuration

| Env var             | Default              | Purpose                                |
| ------------------- | -------------------- | -------------------------------------- |
| `ANTHROPIC_API_KEY` | — (required for live | Auth for the Anthropic SDK             |
|                     | use; not needed for  |                                        |
|                     | unit tests)          |                                        |
| `CLASSIFIER_MODEL`  | `claude-sonnet-4-6`  | Override the model id at the call site |
| `EVALS_LIVE`        | unset                | Set to `1` (with the API key) to run   |
|                     |                      | evals against the real API             |

Sonnet 4.6 is the documented default — strong instruction-following at a
fraction of Opus pricing. Bump via env when needed; the choice flows through
without code changes.

## Retry contract

1. One call to the LLM. If the response fails JSON parse or Zod validation, we
   retry **once** with a stricter user-message suffix (`RETRY_INSTRUCTION`).
2. If the retry also fails, we throw `ClassifierValidationError`. The
   `ingest_review` queue handler (slice 9) catches this and retries the whole
   call with backoff via pg-boss.

The system prompt is identical on both attempts so the prompt cache hit holds.

## Prompt caching

The system prompt (in `prompts/v1.ts`) is sent inside a `cache_control: {
type: "ephemeral" }` block. The dynamic per-Review payload is in the user
message and is NOT cached. First call within the TTL pays write-cost; everything
afterwards is read-cost.

## Bumping the prompt version

The `prompt_version` field is part of the schema and is persisted on every
`classification` row. It's the audit trail for reproducible re-classification.

To ship `v2`:

1. Create `prompts/v2.ts` exporting `SYSTEM_PROMPT`, `buildUserMessage`,
   `RETRY_INSTRUCTION`, and `PROMPT_VERSION = "v2"`.
2. Switch `src/lib/classifier/index.ts` to import from `./prompts/v2`.
   Do NOT edit `v1.ts` — prompt files are append-only so old persisted
   `prompt_version` values stay decipherable from git history.
3. Update `evals/evals.json` `prompt_version` field to `"v2"`.
4. Run `pnpm evals:classifier` (fixture mode) to update `benchmark.json` and
   commit it as the v2 baseline.
5. In PR review, run `EVALS_LIVE=1 ANTHROPIC_API_KEY=... pnpm evals:classifier`
   locally to compare live behaviour against the fixture baseline.

Breaking schema changes (adding a field is fine; repurposing one is not) need
an ADR + a re-classification job over historical rows — see ADR-0004.

## Running the evals

```bash
# Fixture mode (default — no API key needed, deterministic, runs in CI):
pnpm evals:classifier

# Live mode (calls Anthropic for real):
EVALS_LIVE=1 ANTHROPIC_API_KEY=sk-ant-... pnpm evals:classifier
```

Output is written to `src/lib/classifier/evals/benchmark.json`. The current
v1 baseline reports `9/9` cases passing across `29` mechanical assertions in
fixture mode; behavioural assertions are tagged but not scored automatically
(use the `evaluate-skill` LLM-judge step for those).

## Running unit tests

```bash
pnpm test                                # all suites
pnpm vitest run src/lib/classifier       # just the Classifier
```

Unit tests are hermetic — they mock the Anthropic SDK at the
`AnthropicMessageClient` boundary defined in `anthropic-client.ts` and replay
recorded responses from `__fixtures__/anthropic/`. No network. No API key.

## Layout

```
src/lib/classifier/
├── README.md
├── index.ts                       # public classify() API
├── schema.ts                      # Zod schema + Theme/Sentiment/Severity sets
├── anthropic-client.ts            # thin SDK wrapper, mockable in tests
├── prompts/
│   └── v1.ts                      # SYSTEM_PROMPT, buildUserMessage, PROMPT_VERSION
├── __fixtures__/
│   └── anthropic/                 # recorded responses replayed in unit tests
├── __tests__/
│   ├── classify.test.ts
│   └── schema.test.ts
└── evals/
    ├── evals.json                 # Layer-2 eval cases per evaluate-skill format
    ├── run.ts                     # eval runner — produces benchmark.json
    └── benchmark.json             # baseline; commit alongside prompt changes
```
