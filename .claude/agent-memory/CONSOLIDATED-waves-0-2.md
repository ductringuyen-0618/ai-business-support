---
consolidated_from: slices 1-9 (waves 0-2)
written_at: 2026-05-23
status: current
---

# Cross-cutting lessons from the first 9 slices

The first 9 slices established the patterns the rest of the codebase will follow. Read this **before** writing code so you inherit the conventions instead of re-deriving them.

## Stack reminders (locked, do not re-litigate)

- Next.js 15 App Router, TypeScript strict, **pnpm@10**.
- **Drizzle** for schema + migrations (rationale in `README.md`). Two clients: `neon-http` (runtime) at `src/db/client.ts`, `postgres-js` (worker/migrator) at `src/db/node-client.ts`.
- **pg-boss** in its own `pgboss.*` schema. Singleton at `src/queue/boss.ts`. Worker at `src/worker/index.ts`. v10 uses `batchSize`, NOT `teamSize`/`teamConcurrency` — that API was dropped.
- **Clerk** for auth. Middleware at `src/middleware.ts` gates `/app/*` with an explicit 307. Webhook routes are public — see `src/middleware.ts` matcher.
- **Anthropic SDK + Zod** already deps from slice 4. Use `claude-sonnet-4-6` by default. Use `cache_control: ephemeral` on stable system-prompt blocks; never on dynamic user messages.
- **Vitest** as the test runner. `vitest.config.ts` globs both `tests/**/*.test.ts` AND `src/**/*.test.ts`. Don't re-wire it.

## Architectural patterns the codebase expects

- **DI seam in every job handler**: each handler exports a `Deps` interface with overridable functions and a `DEFAULT_DEPS` constant. Tests pass `vi.fn` overrides. No module-level monkey-patching. See `src/queue/handlers/ingest-review.ts` for the canonical example.
- **Repository layer**: SQL lives in `src/db/queries/<table>.ts`. Handlers and routes import from there, never inline SQL. This is the seam tests inject into.
- **Module READMEs**: every `src/lib/<module>/` has a `README.md` covering the contract, the public API, when to bump versions, and any pre-conditions on callers. Follow the pattern.
- **Evals for LLM-touching modules**: `src/lib/<module>/evals/evals.json` + `benchmark.json` + `run.ts` (fixture-default, `EVALS_LIVE=1` opt-in). Follow `src/lib/classifier/evals/` as the template.

## Privacy / safety chokepoints (per the ADRs — non-negotiable)

- **`Redactor` runs before EVERY LLM call.** The `Classifier` interface accepts `redactedText` only — `review_text` (raw) never crosses the LLM boundary. Don't add new LLM-calling code paths that bypass this; if you need one, route it through `redact()` first or refactor to use the existing chokepoint.
- **OAuth is read-only.** Google scope is `business.manage` (read-only). Don't add write scopes — reopening that needs a new ADR superseding ADR-0003.
- **Multi-tenant isolation**: every data query MUST filter by `business_id` from the current Operator's session. The Deletion Request endpoint (slice 15) also scopes by `business_id` even at admin level.

## Schema state (as of post-slice-9)

Migrations through `0004_reviews_and_classifications.sql`. Your next migration is `0005_*`. Use descriptive tags (`drizzle-kit generate` produces random names — rename them).

Tables:

| Table | Owner slice | Notes |
|---|---|---|
| `businesses` | 1 | + `cancelled_at` for ADR-0006 30-day purge |
| `operators` | 1 (+ `deleted_at` from slice 2) | Soft-delete; re-add un-soft-deletes |
| `operator_channel_prefs` | 6 | Composite PK on `(operator_id, channel)` |
| `source_connections` | 8 | AES-GCM encrypted tokens via `src/lib/source-tokens/encrypt.ts`. UNIQUE on `(business_id, source)`. |
| `reviews` | 9 | UNIQUE on `(source, source_review_id)`. `redacted_text` always populated. |
| `classifications` | 9 | PK is `review_id`. Re-classification (prompt v2) overwrites in place. |

## Migration recipe (it's bitten every wave-leader so far)

When two parallel agents both add migrations, the second to merge collides on `drizzle/<NNNN>_*.sql` and `drizzle/meta/_journal.json` and `drizzle/meta/<NNNN>_snapshot.json`. Recipe:

1. Take `origin/main`'s `_journal.json`, `<prior>_snapshot.json`, and any other meta files via `git checkout origin/main -- drizzle/meta/...`.
2. Delete your old `<NNNN>_*.sql`.
3. Run `DATABASE_URL_UNPOOLED='postgresql://x:y@localhost/x' pnpm db:generate` — drizzle-kit diffs the schema against the latest snapshot and produces a fresh migration at the right number.
4. Rename `drizzle-kit`'s random tag (e.g. `0005_lying_proteus.sql`) to something descriptive (`0005_pubsub_idempotency.sql`); update the matching tag in `_journal.json`.

## Parallel-agent coordination

If you're spawned alongside other agents, your prompt will say so. The conventions:

- **Stay in your lane** — don't modify code another agent's prompt mentions.
- **Schema overlap**: both agents add to `src/db/schema.ts` and the migration coordinator (the main orchestrator) resolves at rebase time by taking the union.
- **Queue constants**: `src/queue/boss.ts` accumulates job constants + payloads + `enqueue*` helpers. Multiple agents add different sections; take the union at rebase time.
- **Shared infrastructure** (Resend, Twilio, etc.) — one slice owns the wrapper, others use lighter direct calls; the orchestrator may consolidate later.

## Test conventions

- Tests can go in `tests/**/*.test.ts` (slice 2 convention) OR `src/**/*.test.ts` (slices 3-9 convention). Both are covered by the Vitest glob.
- Repositories are the injection seam. Mock them via `vi.fn`, don't go through `pg-mem` or live Postgres at this maturity level.
- LLM-touching tests use recorded fixture JSON files under `__fixtures__/anthropic/` and a mockable client at `src/lib/<module>/anthropic-client.ts`.
- For Goog Pub/Sub, Resend, Twilio: follow the same DI seam pattern — accept an injectable client, default to the SDK.

## ESLint quirk (worktree artifact)

When running `pnpm lint` from inside a `.claude/worktrees/agent-<id>/` worktree, ESLint may complain about a plugin conflict between the worktree's `.eslintrc.json` and the main repo's (it discovers both because the worktree path is nested inside main). This is **environmental, not a code issue** — running lint on `main` after merge always passes. Don't let it block your PR.

## Reading list

Before you start, read:

1. `CONTEXT.md` — the canonical glossary. Use these terms verbatim.
2. The ADR for your slice's domain (`docs/adr/`).
3. The GitHub issue you're closing (it has the AC checkboxes that are your contract).
4. Any prior `.claude/agent-memory/slice-<n>-*.md` entries for slices you depend on.

## When you finish

Write your own memory entry per the `dreams` skill (`.claude/skills/dreams/SKILL.md`). Keep it under 200 words. Cover: what you built, decisions worth remembering, gotchas, follow-ups.
