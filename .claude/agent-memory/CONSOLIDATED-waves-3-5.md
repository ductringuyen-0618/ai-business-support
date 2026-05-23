---
consolidated_from: slices 10-16 (waves 3-5)
written_at: 2026-05-23
status: current
supersedes: nothing; complements CONSOLIDATED-waves-0-2.md
---

# Cross-cutting lessons from the final 7 slices (waves 3–5)

Read AFTER `CONSOLIDATED-waves-0-2.md`. Together they cover the full MVP.

## What landed in waves 3–5

| Slice | What it shipped | Key files |
|---|---|---|
| 10 (#11) | Pub/Sub webhook + `backfill_source` handler + idempotency ledger | `src/queue/handlers/backfill-source.ts`, `src/app/api/webhooks/google/pubsub/` |
| 11 (#12) | Channel senders (Resend, Twilio) + `fire_incident` + `deliver_escalation` + Operator settings UI + phone-verify | `src/queue/handlers/{fire-incident,deliver-escalation}.ts`, `src/lib/{email/resend,sms/twilio}.ts`, `src/app/app/settings/channels/` |
| 12 (#14) | Dashboard list + filters + drawer + Incident-resolve + backfill banner | `src/app/app/dashboard/`, `src/db/queries/{reviews,incidents}.ts` |
| 13 (#15) | Star-rating trend chart + Theme-frequency stacked-bar chart (Recharts) | `src/app/app/dashboard/_components/{star-trend-chart,theme-frequency-chart,trends-section}.tsx`, `src/db/queries/trends.ts` |
| 14 (#16) | Weekly Digest composer + cron + email send | `src/lib/digest/composer.ts`, `src/queue/handlers/compose-digest.ts`, `src/lib/email/digest-email.ts` |
| 15 (#13) | Deletion Request admin endpoint + CLI + runbook | `src/app/api/internal/deletion-request/`, `scripts/deletion-request.ts`, `docs/runbooks/deletion-request.md` |
| 16 (#17) | Playwright E2E happy-path spec + in-process mocks | `tests/e2e/happy-path.spec.ts`, `src/lib/test-mode/`, `playwright.config.ts` |

## Patterns established that future work should follow

- **`getDefaultClient()` + E2E short-circuit** — every external-SDK wrapper (`src/lib/email/resend.ts`, `src/lib/sms/twilio.ts`, `src/lib/classifier/anthropic-client.ts`, `src/lib/email/backfill-ready.ts`) exposes a `getDefaultClient()` that lazily memoises the SDK client AND short-circuits to the matching mock in `src/lib/test-mode/` when `E2E_TEST_MODE=1`. Add the same shape to any new external-IO wrapper.
- **Drizzle migrations: bump and rename.** When parallel slices both grab the next migration number, the second-to-merge regenerates via `pnpm db:generate`, bumps the number, and renames the auto-generated tag from `drizzle-kit`'s random slug to something descriptive. The recipe is in `CONSOLIDATED-waves-0-2.md`.
- **Cron in UTC, gated locally** — pg-boss v10's cron is UTC-only. For per-Business local-time scheduling (e.g. Monday 08:00 in the Operator's timezone for the Digest), schedule a UTC enqueuer hourly and let it check each Business's local clock. Pattern in `src/queue/handlers/compose-digest.ts`.
- **Idempotency ledger** for inbound webhooks: small table keyed on the provider's message id, insert with `ON CONFLICT DO NOTHING` before doing work. See `processed_pubsub_messages` table + the Pub/Sub webhook handler.
- **Multi-tenant scoping at SQL WHERE** — Reviews scope via `source_connections.business_id` (no direct FK); Incidents scope via `incidents.business_id` (denormalised at fire-time, slice 11). Every list/update query enforces this; integration tests pin it.
- **URL-first filter state** for the dashboard. `src/app/app/dashboard/_components/filters.ts` is the single source of truth for the filter shape — both the trend charts (slice 13) and the Digest email's deep-link (slice 14) use the same `?since=ISO&until=ISO&themes=a,b&...` format.

## Gotchas this wave hit (so you don't)

- **Worktree isolation is imperfect.** Wave 3+ agents repeatedly bled files into each other's workspaces (slice 14 leaking into slice 12, slice 16 leaking into slice 13, etc.). When you see stray files from a sibling slice in your worktree, revert them — let the sibling's PR own the canonical version.
- **Agent sandbox blocks writes to `.claude/agent-memory/`** in some sessions. If your Write tool errors there, surface the intended content in the PR body and the orchestrator will paste it in. (Slices 12, 13, 16 hit this; orchestrator wrote their entries.)
- **pg-boss JSONB round-trips serialise `Date` to string.** The `ingest_review` handler had a latent bug here (caught by the E2E spec — unit tests bypass the queue). Any handler that consumes a `Date` field from a queue payload must rehydrate: `typeof x === "string" ? new Date(x) : x`.
- **Recharts 3.x `formatter`** is `(value: TValue | undefined, name: TName | undefined, ...)` — needs explicit narrowing or TS fails.
- **Tailwind v3 + Next 15 SSR has hydration quirks with native `<dialog>`.** Use `<div role="dialog">` for modals instead.
- **`getDb()` driver-swap for E2E.** The Next runtime uses `@neondatabase/serverless` which only talks to `*.neon.tech` hostnames; when running against a local Postgres for E2E, swap to `postgres-js`. See `src/db/client.ts`.
- **Playwright version pinning matters in sandboxes** — if you upgrade `@playwright/test`, the chromium revision changes and the local `/opt/pw-browsers` install becomes stale. On real CI just run `pnpm exec playwright install chromium` post-install.
- **`require()` with `eslint-disable`**: prefer the inline `eslint-disable-next-line` on the same line as `require()` (prettier will move standalone disable-next-line comments away from the require if the assignment spans multiple lines). Pattern:
  ```ts
  const mock =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./mock") as typeof import("./mock");
  ```

## Schema state at end of wave 5

Migrations through `0007_digests.sql`. Tables in dependency order:

```
businesses
  └── operators (FK)
        └── operator_channel_prefs (composite PK on (operator_id, channel))
              └── phone_verifications (PK on operator_id)
  └── source_connections (UNIQUE on (business_id, source); AES-encrypted tokens)
        └── reviews (UNIQUE on (source, source_review_id); redacted_text always populated)
              └── classifications (PK = review_id)
              └── incidents (UNIQUE on review_id; severity denormalised at fire-time)
                    └── escalations (status enum: queued|sent|failed)
  └── digests (composer body in JSONB)

processed_pubsub_messages (idempotency ledger; no FK)
```

## Test counts and gates

- Unit + integration: **351 tests across 30 files**, all passing.
- LLM evals: Classifier 9/9 cases (29/29 assertions), Digest 5/5 cases (14/14 assertions). Both have `benchmark.json` baselines.
- E2E: 1 Playwright spec, ~28s, fully hermetic (Anthropic / Resend / Twilio / Google all mocked at the SDK boundary).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` all clean on main.

## Where to go next

The MVP is feature-complete per the PRD. Likely next moves:

1. **Wire CI** — repo has no `.github/workflows/` yet. Add one that runs `typecheck`, `lint`, `format:check`, `test`, and `test:e2e` on every PR.
2. **Vercel preview deploys** — slice 1's `pnpm build` works but no agent verified a Vercel preview against real env vars.
3. **First real Business onboarding** — point the bootstrap at a real Neon, Clerk, Google Cloud, Resend, Twilio, Anthropic account; run the migrations; sign up; connect Google.
4. **Per-Business concurrency tuning** — `INGEST_REVIEW_CONCURRENCY=5` is a guess; first prod data will tell us if it's the right ceiling.
5. **Trends nice-to-haves**: empty-day fill on the rolling-avg line chart, persisted disclosure state for the Trends section, mobile-friendly Theme legend.
6. **Deletion Request audit log** — slice 15 punted on persistent admin-action audit; runbook documents it as a follow-up.
