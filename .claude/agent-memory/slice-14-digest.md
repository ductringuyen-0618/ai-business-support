---
slice: 14
issue: 16
branch: slice-14-weekly-digest
written_at: 2026-05-23
---

# Slice 14 — Weekly Digest composer + cron + email send

## What landed

- **Schema**: `digests(id, business_id, period_start, period_end, body jsonb, sent_at)`. Migration `0007_digests.sql`. `DigestBody` is owned by `src/lib/digest/composer-types.ts` and re-exported from `src/db/schema.ts` so the composer module is the single source of truth and `src/lib/digest` does NOT depend on `src/db`.
- **Composer** at `src/lib/digest/composer.ts`. One Anthropic call. Pipeline: `selectCandidates()` → quote-picker (3–5 per dominant Theme, recency-ordered) → user-message build → Anthropic with `cache_control: ephemeral` on the system block → Zod parse → post-parse semantic validation (candidate-id whitelist, celebrate ⇒ all reinforcement, evidence quotes must appear verbatim in input). One retry on failure, then throw `DigestComposerError`.
- **Handler** at `src/queue/handlers/compose-digest.ts`. Loads Business, resolves timezone, computes Monday-to-Monday windows in local time, fans into the composer, persists `digests` row BEFORE sending, then sends one email per Operator via `src/lib/email/resend.ts`. Skips Businesses with `< 1` Review in the period.
- **Cron**: pg-boss cron is UTC-only, so we ship two queues — `compose_digest` (handler above) and `compose_digest_enqueuer` (hourly tick scheduled `0 * * * *`). The enqueuer iterates active Businesses, checks `isMondayEightAmLocal(now, businessTz)`, and emits with `singletonKey: <business_id>-<isoYearWeek>` so worker restarts within the same hour can't double-fire.
- **Email** at `src/lib/email/digest-email.ts`. Pure HTML+inline-CSS render. CTA links to `${APP_BASE_URL}/app/dashboard?since=<ISO>&until=<ISO>` — coordinated URL shape with slice 12.
- **Evals**: `src/lib/digest/evals/{evals.json,run.ts,benchmark.json}`. 5 cases (high-volume mixed, all-positive→celebrate, all-negative→remediation, zero-Review→handler skip, barbershop industry-misfit). Baseline 5/5 cases, 14/14 mechanical assertions.

## Decisions worth remembering

- **DigestBody ownership.** Lives in `composer-types.ts`. `src/db/schema.ts` re-exports it. Avoids circular intent — composer is the producer; schema is the persistence shape.
- **Model**: `claude-sonnet-4-6` default, override via `DIGEST_COMPOSER_MODEL`. Mirrors the Classifier's env-override seam (`CLASSIFIER_MODEL`).
- **No partial Digest rows**. If composer throws, the handler does NOT write. pg-boss retries the whole job — fine because the LLM call is the only side-effect-free expensive step.
- **Evidence redaction defence-in-depth**. The composer drops any LLM-emitted `redactedQuote` that doesn't appear verbatim in the input quote set, AND replaces the LLM's `reviewId` + `themes` on each evidence item with the canonical values from input (defends against the LLM correctly quoting but mis-attributing).
- **Reference timezone**. `operators[0].timezone` per the AC — implemented as "first Operator by createdAt who has an `operator_channel_prefs` row, falling back to UTC". A brand-new Business with no prefs rows still gets a Digest (in UTC) rather than being silently skipped.

## Coordination notes

- **Schema overlap**: only additive (`digests` table + types). No collision with slice 12.
- **Queue constants overlap**: added `COMPOSE_DIGEST_JOB`, `COMPOSE_DIGEST_ENQUEUER_JOB`, payload types, and enqueue helper to `src/queue/boss.ts`. Worker now subscribes to both queues.
- **URL filter contract with slice 12**: email CTA uses `?since=<ISO>&until=<ISO>`. If slice 12 lands a different shape we update `buildDashboardUrl()` in `src/lib/email/digest-email.ts`.

## Gotchas

- pg-boss `boss.schedule(name, cron)` takes UTC. Don't try to schedule per-Business cron strings — the hourly enqueuer pattern is the simpler correct alternative.
- Prettier reformatted `evals.json`, `composer.ts`, `prompts/v1.ts`, the handler test, etc. after the initial generate. Re-running `pnpm format:check` then `pnpm evals:digest` regenerates a formatted `benchmark.json`; commit both.
- Vitest spread-arg type errors required `Parameters<typeof origInsert>[0]` typing on the wrapped fn — `(...args)` doesn't infer through `vi.fn` cleanly.

## Quality gates

- `pnpm typecheck` clean.
- `pnpm format:check` clean.
- `pnpm test` — 330 passed (28 files).
- `pnpm evals:digest` — 5/5 pass, 14/14 mechanical assertions.
- `pnpm lint` / `pnpm build` deferred (worktree env per CONSOLIDATED-waves-0-2.md).
