/**
 * Slice 13: trend-chart read helpers.
 *
 * Two aggregate queries feed the dashboard's Trends section (issue #15):
 *
 *   1. `getStarRatingTrend({ businessId, filters })` — one row per calendar
 *      day in the filtered range, with the per-day count + a 30-day rolling
 *      average computed via a SQL window function.
 *   2. `getThemeFrequency({ businessId, filters })` — one row per (ISO week,
 *      Theme) tuple with a count; the data-shaping helper in
 *      `_components/shape-trends.ts` then pivots that into a stacked-bar
 *      shape Recharts expects.
 *
 * Why aggregate in SQL?
 *   AC says: render 1y × 3,000 Reviews in <2s. Bucketing 3,000 rows in JS is
 *   doable but every extra round-trip + every extra row over the wire eats
 *   into the budget. Postgres' `date_trunc` + window functions are the right
 *   tool — they run on the warm row pages already cached for the list query
 *   and the wire format is one row per day / per (week, theme) instead of
 *   per Review.
 *
 * Scoping: every query filters by `business_id` via `source_connections`
 * (multi-tenant isolation — same chokepoint as `listReviewsForBusiness`).
 * The `ListReviewsFilters` type is intentionally reused so a single source of
 * truth (the URL parser in `_components/filters.ts`) feeds list + charts.
 *
 * The fake-db at `tests/dashboard/fake-trends-db.ts` mirrors these semantics
 * for unit tests.
 */
import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { classifications, incidents, reviews, sourceConnections } from "@/db/schema";

import type { ListReviewsFilters } from "@/db/queries/reviews";

/**
 * One row in the star-rating trend series.
 *
 * - `date` is UTC midnight on the day the bucket represents (Postgres
 *   `date_trunc('day', posted_at)`).
 * - `count` is the number of Reviews posted that day under the filters.
 * - `rollingAvg` is the 30-day trailing average star rating, computed via
 *   `AVG(star_rating) OVER (ORDER BY day ROWS BETWEEN 29 PRECEDING AND
 *   CURRENT ROW)`. We compute it in SQL so the React layer never has to
 *   reshape a 3,000-row stream.
 *
 * Days with zero Reviews are NOT in the series — the chart layer renders
 * the empty-state when the entire series is empty. (Days inside the range
 * but between two non-empty days are simply elided; Recharts draws a
 * straight line across, which is the right visual for a sparse trend.)
 */
export interface StarRatingTrendPoint {
  /** UTC midnight, ISO yyyy-mm-dd in render. */
  date: Date;
  count: number;
  /** Mean star rating for the day. 1.0–5.0. */
  dayAvg: number;
  /** 30-day rolling average ending on this day (inclusive). 1.0–5.0. */
  rollingAvg: number;
}

export interface GetStarRatingTrendInput {
  businessId: string;
  filters?: ListReviewsFilters;
}

/**
 * Per-day Review aggregates + a 30-day rolling average star rating.
 *
 * Implementation: a CTE buckets Reviews by `date_trunc('day', posted_at)` and
 * computes the per-day average + count. The outer SELECT then adds a window
 * function for the 30-day trailing average. The window is "rows preceding"
 * rather than "range preceding" because empty days are absent from the CTE —
 * which means the window is effectively "the last 30 days that had Reviews",
 * not "the last 30 calendar days". For a Review stream that fires daily this
 * is identical; for a quiet Business the rolling line is slightly less jumpy
 * than the strict calendar definition. The AC says "rolling 30-day" without
 * pinning the empty-day semantics — we documented it here so the next agent
 * doesn't need to guess.
 */
export async function getStarRatingTrend(
  input: GetStarRatingTrendInput,
): Promise<StarRatingTrendPoint[]> {
  const db = getDb();
  const filters = input.filters ?? {};
  const conditions = buildTrendConditions(input.businessId, filters);

  // We construct the CTE + window query as a single raw SQL block. Drizzle's
  // query builder doesn't have a great window-function story for this shape,
  // and the predicates are already typed via `and(...)`. The `sql` helper
  // parameterises every value so injection surface is zero.
  const rows = await db
    .select({
      day: sql<string>`date_trunc('day', ${reviews.postedAt})::date::text`,
      count: sql<number>`count(*)::int`,
      dayAvg: sql<number>`avg(${reviews.starRating})::float8`,
      // 30-day rolling: 29 preceding rows + current row = a 30-row window
      // ordered by the truncated day. Each row represents one day, so 30
      // rows == 30 distinct days.
      rollingAvg: sql<number>`avg(avg(${reviews.starRating})) over (order by date_trunc('day', ${reviews.postedAt}) rows between 29 preceding and current row)::float8`,
    })
    .from(reviews)
    .innerJoin(sourceConnections, eq(reviews.sourceConnectionId, sourceConnections.id))
    .leftJoin(classifications, eq(classifications.reviewId, reviews.id))
    .leftJoin(incidents, eq(incidents.reviewId, reviews.id))
    .where(conditions)
    .groupBy(sql`date_trunc('day', ${reviews.postedAt})`)
    .orderBy(sql`date_trunc('day', ${reviews.postedAt})`);

  return rows.map((r) => ({
    date: new Date(r.day),
    count: r.count,
    dayAvg: Number(r.dayAvg),
    rollingAvg: Number(r.rollingAvg),
  }));
}

/**
 * One bucket in the Theme-frequency series.
 *
 * - `weekStart` is UTC midnight of the ISO Monday that opens the week
 *   (`date_trunc('week', posted_at)` in Postgres — ISO week, starts Monday).
 * - `theme` is one of the fixed top-level Theme literals (CONTEXT.md). We
 *   leave it as a plain string at the query layer; the data-shaping helper
 *   filters to the THEME enum.
 * - `count` is the number of Reviews tagged with that Theme in that week.
 *
 * Note: a Review tagged with N Themes contributes to N buckets (one per
 * Theme it carries). The `jsonb_array_elements_text` unnest is what makes
 * this fan-out cheap in SQL.
 */
export interface ThemeFrequencyBucket {
  weekStart: Date;
  theme: string;
  count: number;
}

export interface GetThemeFrequencyInput {
  businessId: string;
  filters?: ListReviewsFilters;
}

/**
 * Per-(ISO week, Theme) Review counts.
 *
 * `classifications.themes` is a JSONB array of Theme strings. We unnest it
 * with `jsonb_array_elements_text` (a lateral set-returning function), group
 * by `(date_trunc('week', posted_at), theme)`, and count. Unclassified
 * Reviews — those with no `classifications` row — contribute nothing to the
 * series (the inner-join on classifications drops them). That matches the
 * Review-list behaviour when a Theme filter is applied.
 */
export async function getThemeFrequency(
  input: GetThemeFrequencyInput,
): Promise<ThemeFrequencyBucket[]> {
  const db = getDb();
  const filters = input.filters ?? {};
  const conditions = buildTrendConditions(input.businessId, filters);

  const rows = await db
    .select({
      week: sql<string>`date_trunc('week', ${reviews.postedAt})::date::text`,
      theme: sql<string>`theme_elem.value`,
      count: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .innerJoin(sourceConnections, eq(reviews.sourceConnectionId, sourceConnections.id))
    .innerJoin(classifications, eq(classifications.reviewId, reviews.id))
    .leftJoin(incidents, eq(incidents.reviewId, reviews.id))
    // The lateral cross-join unnests the JSONB array into one row per Theme.
    // `jsonb_array_elements_text` is the text-typed variant so the row's
    // `value` column is a plain `text` (vs `jsonb` from the un-suffixed fn).
    .innerJoin(
      sql`lateral jsonb_array_elements_text(${classifications.themes}) as theme_elem(value)`,
      sql`true`,
    )
    .where(conditions)
    .groupBy(sql`date_trunc('week', ${reviews.postedAt})`, sql`theme_elem.value`)
    .orderBy(sql`date_trunc('week', ${reviews.postedAt})`, sql`theme_elem.value`);

  return rows.map((r) => ({
    weekStart: new Date(r.week),
    theme: r.theme,
    count: r.count,
  }));
}

/**
 * Shared predicate builder. Mirrors `buildReviewConditions` in
 * `reviews.ts` so the trends queries narrow on identically the same filters
 * as the list (date range, star rating, incidents-only).
 *
 * Theme filter is intentionally NOT applied to the trend queries — both
 * charts are themselves Theme-aware (the bar chart IS the Theme breakdown;
 * the line chart is rating-only). Narrowing to a single Theme would defeat
 * the purpose of the visualization. The list still respects the Theme
 * filter; the charts respect everything else.
 */
function buildTrendConditions(businessId: string, filters: ListReviewsFilters) {
  const parts = [eq(sourceConnections.businessId, businessId)];

  if (filters.ratings && filters.ratings.length > 0) {
    parts.push(inArray(reviews.starRating, filters.ratings));
  }
  if (filters.since) {
    parts.push(gte(reviews.postedAt, filters.since));
  }
  if (filters.until) {
    parts.push(lte(reviews.postedAt, filters.until));
  }
  if (filters.incidentsOnly) {
    parts.push(isNotNull(incidents.id));
  }

  return and(...parts);
}
