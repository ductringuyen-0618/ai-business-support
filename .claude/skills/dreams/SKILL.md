---
name: dreams
description: Write structured memory after completing a unit of work so future agents pick up where you left off — slice IDs, key decisions, gotchas, what NOT to redo. Read prior entries on startup to inherit context. Use when an agent finishes a slice/PR, completes a non-trivial multi-step task, or begins work on something that may have prior context.
---

# Dreams

Persistent memory across agent runs in this repo. Each agent writes a brief, structured note when it finishes meaningful work; the next agent reads those notes on startup so it doesn't repeat decisions, re-hit known gotchas, or contradict prior design choices.

This is a **filesystem shim** that mirrors what Anthropic's [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams) API does on the managed platform — Dreams there consolidates session transcripts into a curated `memory_store`; we approximate that by having each agent write a note directly at end-of-work and committing it. See the bottom of this file for the real API when this project migrates.

## When to write a memory entry

**Required** — when you:

- Open a PR for a sliced feature (issue → PR pattern).
- Finish a non-trivial multi-step task that another agent will likely build on.
- Make a defensible-choice decision (picked X over Y) that future agents would otherwise re-litigate.

**Optional** — when you:

- Hit a gotcha or surprise that cost you >10 minutes (so the next agent doesn't).
- Discover that the codebase / docs are wrong or misleading about something.

**Don't write entries** for:

- Trivial commits (fix typo, rename variable).
- Things already captured in commit messages, PR descriptions, ADRs, or `CONTEXT.md` — those are the canonical homes for that information. The memory entry is for tacit knowledge that wouldn't fit anywhere else.

## When to read prior entries

On **every** agent startup, before writing code:

```bash
ls .claude/agent-memory/ 2>/dev/null
```

If files exist, read them. They're short (target ≤ 200 words each) — scan them all. They surface:

- "Slice N did X this way, don't re-debate it."
- "When you see error Y, the cause is Z, not what the message implies."
- "The codebase uses convention Q for new modules."

## How to write an entry

File: `.claude/agent-memory/<slug>.md` — slug is `slice-<n>-<short-name>` for slice work, otherwise a short descriptive slug.

Format:

```markdown
---
slice: <issue number, e.g. #10>
pr: <PR number, e.g. #27>
branch: <branch name>
written_at: <YYYY-MM-DD>
---

# <Short title — what this entry is about>

## What I built

<1–3 sentences. Pointers to key files. Skip what's already in the PR body.>

## Decisions worth remembering

- **<Topic>**: <Decision> — <one-line rationale>. Reopening this needs a counter-argument, not a default reset.
- ...

## Gotchas the next agent should know

- <Surprise + workaround. Skip if none.>
- ...

## What's still rough / known follow-ups

- <Thing I knowingly left undone, who should pick it up, why.>
- ...
```

Keep it tight. ≤ 200 words. If you have more to say, write an ADR or a runbook instead — those have a different shelf-life.

## How to commit

The memory file goes in the same PR as your code:

```bash
git add .claude/agent-memory/<your-slug>.md
git commit -m "Add memory entry for <slice/task>"
```

It's checked into the repo so it travels with `main`. No separate publication step.

## Pruning

Memory entries are append-only by default. **Don't** delete or rewrite other agents' entries unless you're explicitly consolidating (e.g. a "dream" pass — see below).

When to consolidate:

- The directory has >20 entries and the next agent's startup-read becomes noisy.
- Two entries directly contradict each other and one is now stale.

In those cases, write a `CONSOLIDATED-<date>.md` that supersedes a batch, and `git mv` the originals into `.claude/agent-memory/archive/<date>/`. Reference the originals in the consolidated entry so the history isn't lost. This mirrors how the real Dreams API produces a new `memory_store` from an old one + sessions without ever modifying the input.

## Example

Slice 9 (`ingest_review`) might have written:

```markdown
---
slice: #10
pr: #26
branch: slice-9-ingest-review
written_at: 2026-05-23
---

# ingest_review: how to extend the pipeline

## What I built

- `src/queue/handlers/ingest-review.ts` — the chokepoint: Redactor → Classifier → DB.
- Companion repository files in `src/db/queries/{reviews,classifications,source-connections}.ts`.

## Decisions worth remembering

- **DI seam everywhere**: handler accepts `IngestReviewDeps` with overridable `redact`, `classify`, `upsert*`, `enqueueFireIncident`. Future jobs should match this shape — tests use `vi.fn` overrides, no module-level monkey-patching.
- **Persist Review BEFORE Classifier**: step 4 writes the row; step 5 calls the LLM. If the LLM fails past pg-boss retries, the Review is still visible in the dashboard as "unclassified" (slice 12).
- **`redacted_text` is always populated** (possibly `""`). The raw `review_text` can be nulled later by Deletion Request (slice 15); `redacted_text` is the only thing Anthropic ever saw.

## Gotchas the next agent should know

- pg-boss v10 dropped `teamSize`/`teamConcurrency` from `WorkOptions` — use `batchSize` on the work() call.
- The `findSourceConnectionWithBusiness` query needs an `innerJoin`, not a `leftJoin` — a vanished `source_connections` row should return `null` and short-circuit the job, not return a Review with a null Business.

## What's still rough / known follow-ups

- `INGEST_REVIEW_RETRY` is `retryLimit: 2` (3 total attempts). Tune if real LLM error rates suggest otherwise.
- Per-business concurrency cap (5) is set at the worker level via `batchSize`. If a Business is loud and starves others, switch to per-key concurrency once pg-boss supports it cleanly.
```

## The real Dreams API (for when we move to Managed Agents)

When this project migrates to Anthropic's [Managed Agents platform](https://platform.claude.com/docs/en/managed-agents), replace the filesystem approach with:

1. Each agent session writes to a `memory_store` via `client.beta.memory_stores.write(...)` during execution.
2. Periodically (nightly cron, or after every N sessions), run a **dream**:

```python
dream = client.beta.dreams.create(
    inputs=[
        {"type": "memory_store", "memory_store_id": store_id},
        {"type": "sessions", "session_ids": recent_session_ids},
    ],
    model="claude-opus-4-7",
    instructions=(
        "Consolidate agent-memory entries. Merge duplicates. "
        "Drop stale entries that have been superseded by ADRs or later memory entries. "
        "Surface cross-cutting patterns (e.g. 'every job handler uses a DI deps interface')."
    ),
)
```

Then poll `client.beta.dreams.retrieve(dream.id)` until `status == "completed"`, take `dream.outputs[0].memory_store_id`, attach it to new sessions as the working memory store.

**Beta headers** the SDK sets automatically: `managed-agents-2026-04-01,dreaming-2026-04-21`.

**Limits**: ≤100 sessions per dream, ≤4096-char `instructions`. Supported models: `claude-opus-4-7`, `claude-sonnet-4-6`.

The shape of what we write in the filesystem shim above maps 1:1 onto what we'd write to a `memory_store` later — the consolidation step is what changes.
