---
slice: 16
issue: 17
pr: 33
branch: slice-16-e2e
written_at: 2026-05-23
---

# Slice 16 — Playwright happy-path E2E spec

## What landed

- Single spec `tests/e2e/happy-path.spec.ts` exercises the full pipeline:
  test-mode auth header → Connect Google (OAuth round-trip short-circuited)
  → backfill → ingest → classify (mocked) → fire_incident → deliver_escalation
  (mocked Resend) → dashboard renders Reviews + Theme pills → drawer →
  Mark resolved → badge clears → assert Resend mock recorded the email.
- `tests/e2e/setup/` boots an ephemeral Postgres 16 (initdb + pg_ctl, no
  Docker), runs `pnpm db:migrate`, spawns Next dev server with
  `E2E_TEST_MODE=1` + the pg-boss worker. Whole spec runs in ~28s.
- `src/lib/test-mode/` holds in-process mocks for Anthropic / Resend / Twilio,
  plus stubs for `@clerk/nextjs(/server)?`. Activated by the env var; aliased
  via `next.config.ts` webpack config.
- Pinned Playwright to `1.55.0` — the sandbox at `/opt/pw-browsers` carries
  chromium-1194, which is what 1.55.x uses. Newer Playwrights download a
  fresh browser; that download was blocked in this sandbox.

## Decisions worth remembering

- **DB approach: real Postgres via system package, NOT Docker / pglite.**
  Drizzle's neon-http + postgres-js dialects both want a real TCP Postgres.
  pg-mem / pglite would have meant rewriting the schema. `initdb` + `pg_ctl`
  is reliable on Ubuntu LTS + macOS Homebrew. Cost: one extra system dep
  (`postgresql-16`). When running as root we shell pg commands through
  `sudo -u postgres -E` because `initdb` refuses root.
- **`getDb()` driver-swap.** In E2E mode the Next runtime swaps from
  neon-http to postgres-js (the neon driver only talks to `*.neon.tech`
  hostnames; pointing it at `127.0.0.1` produces opaque URL parse errors).
  Type-narrowed via a one-line cast — both drivers expose the same Drizzle
  query surface behaviourally.
- **Google OAuth: short-circuit in the server, NOT via `page.route`.**
  Playwright's `page.route` intercept of top-level main-frame navigations to
  off-origin hostnames was flaky (browser landed on a real Google error
  page before the route fired). Instead, `oauth/start` in E2E mode redirects
  straight to `oauth/callback` with a real signed state cookie, and
  `exchangeGoogleAuthCode` returns canned tokens. Belt-and-braces
  `context.route` aborts any `*.google*.com` traffic that might leak.
- **Clerk: webpack alias to local stubs.** Touching every `auth()` /
  `currentUser()` call site would have been invasive. Aliasing the entire
  Clerk SDK to test stubs in `next.config.ts` (gated by `E2E_TEST_MODE=1`)
  keeps production untouched. The stub reads identity from the
  `x-e2e-clerk-user-id` request header.
- **Mock recorder: JSONL on disk, not IPC.** Mock services run inside the
  Next dev server process; the spec runs in a separate Playwright process.
  Files are the lowest-common-denominator IPC; volume is tiny; survives
  crashes deterministically. Both sides resolve the path via
  `runtime-state.ts` (the on-disk handoff between globalSetup and the spec).

## Bug fixed in-flight (latent slice 9/10 issue)

`ingest_review`'s `posted_at` was a `Date` in the unit tests but a string
after pg-boss JSONB round-trip in production. The slice-9 / -10 unit tests
bypass the queue so the bug never showed. The E2E spec surfaced it as
`TypeError: value.toISOString is not a function` on the first ingest job.
Fix is a one-liner in `processOne` — rehydrate to `Date` if it came back
as a string.

## Gotchas / fragility

- **Playwright version pinning matters.** If the project upgrades
  `@playwright/test`, the chromium revision changes and the local
  `/opt/pw-browsers` install becomes stale. A real CI machine runs
  `pnpm exec playwright install chromium` so it doesn't care; local dev
  needs the matching version.
- **Hostname normalisation.** Next dev server's `request.url` sometimes
  reports `localhost` even when the browser is at `127.0.0.1`. We bind
  the dev server to `localhost` in `globalSetup` to avoid the mismatch
  (cookie scoping would break otherwise — the OAuth state cookie is
  host-scoped).
- **Worker concurrency.** The worker drains `ingest_review` with
  `batchSize=5` (slice 9 default). 5 fixture reviews → one batch → the
  whole pipeline drains in one cycle, which is why the test is fast. If a
  future change drops the batch size, the spec's `waitForCondition`
  timeouts (30s) are still generous.

## Quality gates

- `pnpm typecheck` — clean.
- `pnpm format:check` — clean.
- `pnpm test` — 330 passed.
- `pnpm test:e2e` — 1 passed in 27–28s. Re-ran 3× to confirm determinism.
