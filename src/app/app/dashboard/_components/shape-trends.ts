/**
 * Slice 13: pure data-shaping helpers for the trend charts.
 *
 * Recharts wants two specific input shapes:
 *
 *   - Line chart (`<LineChart data={…}>`): one object per X-axis tick. The
 *     star-rating trend therefore wants
 *       `[{ date: 'yyyy-mm-dd', rollingAvg, count, dayAvg }, …]`.
 *   - Stacked bar chart (`<BarChart data={…}>` + one `<Bar>` per series):
 *     one object per X-axis tick (= per ISO week) with one numeric key per
 *     stacked series (= per Theme).
 *
 * The query layer (`src/db/queries/trends.ts`) returns "long-form" rows —
 * one per (day) or per (week, theme). This module pivots/normalises into
 * Recharts' "wide-form" expected shape. Keeping the pivot here:
 *
 *   - lets the SQL stay simple and index-friendly (no PIVOT, no
 *     cross-tabulation in Postgres);
 *   - lets the React layer stay dumb (it just renders props);
 *   - is easy to unit-test from a pure input → pure output perspective.
 */
import { THEMES, type Theme } from "@/lib/classifier/schema";

import type { StarRatingTrendPoint, ThemeFrequencyBucket } from "@/db/queries/trends";

import { orderedThemes } from "./theme-palette";

/** Shape consumed by the Recharts <LineChart>. */
export interface StarTrendChartPoint {
  /** ISO yyyy-mm-dd string. Recharts uses the value verbatim for tooltips. */
  date: string;
  /** 30-day rolling average, rounded to two decimals for tooltip readability. */
  rollingAvg: number;
  /** Same-day average — used by the tooltip alongside `count`. */
  dayAvg: number;
  /** Count of Reviews posted that day (tooltip). */
  count: number;
}

/**
 * Convert the query layer's StarRatingTrendPoint[] into the wide-form
 * Recharts expects. Rounds floats to 2 d.p. because the tooltip is the only
 * surface that renders them and trailing precision is just visual noise.
 */
export function shapeStarTrend(rows: StarRatingTrendPoint[]): StarTrendChartPoint[] {
  return rows.map((r) => ({
    date: toIsoDate(r.date),
    rollingAvg: round2(r.rollingAvg),
    dayAvg: round2(r.dayAvg),
    count: r.count,
  }));
}

/** Shape consumed by the Recharts stacked <BarChart>. */
export interface ThemeFrequencyChartBar {
  /** ISO yyyy-mm-dd of the Monday opening this ISO week. */
  weekStart: string;
  /** Per-Theme counts. Missing Themes render as 0 in Recharts. */
  counts: Record<Theme, number>;
  /** Total Reviews this week, for an at-a-glance hover summary. */
  total: number;
}

/**
 * Convert (weekStart, theme, count) long-form rows into the wide-form bar
 * chart shape.
 *
 * - Themes outside the canonical `THEMES` set are dropped — the chart legend
 *   only knows colours for the fixed set. A future Theme would need a
 *   palette entry first (see `theme-palette.ts`).
 * - Weeks with zero rows after that filter are dropped entirely.
 * - Each week's `counts` object always carries every Theme (zero-filled for
 *   ones with no contribution that week). This means the React layer can
 *   render one `<Bar dataKey="counts.service" />` per Theme without per-row
 *   `undefined` guards.
 */
export function shapeThemeFrequency(rows: ThemeFrequencyBucket[]): ThemeFrequencyChartBar[] {
  const knownThemes = new Set<string>(THEMES);
  // Group by week first.
  const byWeek = new Map<string, Map<Theme, number>>();
  for (const row of rows) {
    if (!knownThemes.has(row.theme)) continue;
    const isoWeek = toIsoDate(row.weekStart);
    let weekMap = byWeek.get(isoWeek);
    if (!weekMap) {
      weekMap = new Map();
      byWeek.set(isoWeek, weekMap);
    }
    weekMap.set(row.theme as Theme, (weekMap.get(row.theme as Theme) ?? 0) + row.count);
  }

  // Then emit one wide-form row per week, ordered chronologically.
  const sortedWeeks = Array.from(byWeek.keys()).sort();
  return sortedWeeks.map((weekStart) => {
    const counts = zeroFilledThemes();
    const weekMap = byWeek.get(weekStart);
    let total = 0;
    if (weekMap) {
      for (const [theme, n] of weekMap.entries()) {
        counts[theme] = n;
        total += n;
      }
    }
    return { weekStart, counts, total };
  });
}

/**
 * Returns the set of Themes that should appear in the chart legend for the
 * given series — only the ones with any non-zero count across the range.
 * Avoids the visual noise of a legend with 8 always-shown entries when only
 * 2 are present in the data.
 *
 * Order respects `orderedThemes()` so legend, bars, and palette agree.
 */
export function legendThemes(series: ThemeFrequencyChartBar[]): Theme[] {
  const seen = new Set<Theme>();
  for (const bar of series) {
    for (const theme of Object.keys(bar.counts) as Theme[]) {
      if (bar.counts[theme] > 0) seen.add(theme);
    }
  }
  return orderedThemes().filter((t) => seen.has(t));
}

// --- helpers ---

function toIsoDate(d: Date): string {
  // We rely on Postgres returning UTC midnight from `date_trunc`; toISOString
  // then yields `2026-05-20T00:00:00.000Z`, which we slice to `2026-05-20`.
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function zeroFilledThemes(): Record<Theme, number> {
  const out = {} as Record<Theme, number>;
  for (const t of THEMES) out[t] = 0;
  return out;
}
