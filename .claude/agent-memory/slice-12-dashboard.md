---
slice: #14
pr: #30
branch: slice-12-dashboard
written_at: 2026-05-23
note: Written by the orchestrator on the agent's behalf — the agent's worktree sandbox denied writes to .claude/agent-memory/.
---

# Operator dashboard at /app/dashboard

## What I built

- Server component `src/app/app/dashboard/page.tsx` composes filter bar → Review list → drawer → banners (backfill / errored-token / unclassified) → unresolved-Incidents badge in nav.
- URL-driven filter state: pure parser/serializer at `src/app/app/dashboard/_components/filters.ts` with round-trip tests at `filters.test.ts`. Filters in the URL = the single source of truth.
- 3 new endpoints under `src/app/api/`: `incidents/[id]/resolve`, `sources/[id]/retry-backfill`, `reviews/reclassify-failed`. All auth-gated, scoped to the Operator's `business_id` at the SQL WHERE clause.
- Query helpers added to `src/db/queries/reviews.ts` and `src/db/queries/incidents.ts`.
- In-memory fake DB at `tests/dashboard/fake-dashboard-db.ts` mirrors the SQL semantics for integration tests.

## Decisions worth remembering

- **`classifications.themes` filtering uses Postgres `?|` operator via drizzle raw SQL.** Theme literals validated against `[a-z_]+` regex before inlining (defense-in-depth alongside the URL parser that already maps to the THEME enum).
- **Drawer is a `<div role="dialog">`, not a native `<dialog>`.** Tailwind v3 + Next 15 SSR has hydration quirks with native `<dialog>`. Skip the platform primitive here.
- **Two-query pagination** (page rows + count) sharing the same WHERE shape — portable across `neon-http` and `postgres-js`. Don't try to push a window function across the runtime boundary.
- **Filter changes reset `page` to 1**; pagination preserves filters. Don't let the user paginate into stale results.
- **Multi-tenant isolation** lives at the SQL WHERE clause. Reviews are scoped via `source_connections.business_id` (Reviews have no direct `business_id`); Incidents are scoped via `incidents.business_id` (denormalised at fire-time, slice 11).

## Gotchas the next agent should know

- **Slice 14 file bleed**: when slice 12 + slice 14 ran in parallel, slice 14's untracked files appeared in slice 12's workspace (worktree isolation was imperfect). If a wave-5 agent sees stray files from a sibling slice, it's that, not a real conflict — let the sibling's PR own them; don't stage them yourself.
- **Sandbox couldn't write to `.claude/agent-memory/`** from the slice 12 agent's worktree. The orchestrator wrote this entry. If you hit the same wall, surface it in the PR body and the orchestrator will write the entry for you.

## What's still rough / known follow-ups

- The reclassify-failed endpoint enqueues `ingest_review` for failed rows but doesn't yet have a UI status indicator — operators see the banner disappear and have to refresh. Live progress would be a small follow-up.
- Backfill banner reads `loaded_count / estimated_total` but doesn't render a fancy progress bar — a simple text fraction. Slice 13 (trend charts) doesn't depend on this; aesthetic upgrade can wait.
- Drawer doesn't have keyboard navigation (Esc-to-close works; Tab-trap doesn't). Accessibility follow-up.
