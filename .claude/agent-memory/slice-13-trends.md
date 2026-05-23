---
slice: #15
pr: #32
branch: slice-13-trends
written_at: 2026-05-23
note: Written by the orchestrator — agent's sandbox denied writes to .claude/agent-memory/ (same as slice 12).
---

# Dashboard trend charts (Recharts)

## What I built

- `src/db/queries/trends.ts` — `getStarRatingTrend` (day bucketing + 30-day rolling avg via SQL window function) and `getThemeFrequency` (ISO-week bucketing + `jsonb_array_elements_text` unnest). Both scope by `business_id` via `source_connections` and reuse slice 12's `ListReviewsFilters`.
- `src/app/app/dashboard/_components/shape-trends.ts` — pure long→wide pivot for Recharts; unit-tested independently.
- `_components/{theme-palette,star-trend-chart,theme-frequency-chart,trends-section}.tsx` — Recharts client components; central Theme→color+polarity mapping.
- `tests/dashboard/fake-trends-db.ts` + `trends-queries.test.ts` — 9 integration tests over the in-memory mirror.
- `_components/shape-trends.test.ts` — 12 pure unit tests including a 1-year × 3,000-Review soft perf check (<500ms).

## Decisions worth remembering

- **Recharts** chosen over Visx/Tremor — React-first, Tailwind-friendly, Next 15 compatible with `"use client"`. Documented in `README.md` "Why Recharts?".
- **Theme filter is NOT applied to trend queries** — the bar chart IS the breakdown; narrowing to one Theme would defeat the visualization. Rating + date + incidentsOnly DO apply. Documented in `buildTrendConditions`.
- **Click-to-filter legend** writes the URL `themes` param via the existing `serializeDashboardFilters` writer. No new URL contract — coordinates cleanly with slice 12 and slice 14.
- **Empty days are absent** from the star series; the 30-row SQL window is "last 30 non-empty days", not "last 30 calendar days". AC didn't pin this; choice documented inline.
- **Empty state** rendered by section wrapper, not individual charts — avoids Recharts broken-axis on `data=[]`.
- **Aggregation in SQL, not JS.** 3,000-row datasets never ship to the browser.

## Gotchas the next agent should know

- **Recharts 3.x `formatter` signature** is `(value: TValue | undefined, name: TName | undefined, ...)` — naive signatures don't compile, needs explicit narrowing.
- **`pnpm format:check` may transiently ENOENT mid-run** if a sibling agent deletes untracked files. Re-run after clean.
- **Sibling slice 16 file bleed**: worktree isolation imperfect — slice 16 files (`src/lib/test-mode/*`, modifications to `lib/email`, `lib/sms`, `lib/classifier/anthropic-client`) appeared repeatedly. Reverted each time; slice 16's PR owns them.
- **Sandbox can't write `.claude/agent-memory/`** from this worktree (same wall as slice 12). Surface in PR body; orchestrator writes the entry.

## What's still rough / known follow-ups

- Empty-day fill on the rolling-avg line chart (currently sparse).
- Persisted disclosure state (cookie) so Operators don't re-toggle the Trends section on every visit.
- Mobile legend overflow ("More …") for the 8-Theme chip row.
