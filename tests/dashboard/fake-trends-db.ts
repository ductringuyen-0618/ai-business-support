/**
 * In-memory mirror of `src/db/queries/trends.ts`. Used by `trends-queries.test.ts`
 * to pin the SQL semantics without booting Postgres.
 *
 * Mirrors:
 *   - `getStarRatingTrend({ businessId, filters }) -> StarRatingTrendPoint[]`
 *     Bucketed by UTC day; emits a 30-day rolling avg over the non-empty
 *     days (matches the production SQL's "rows preceding" window — empty
 *     days are absent from the series, so the window is over the last 30
 *     non-empty days).
 *   - `getThemeFrequency({ businessId, filters }) -> ThemeFrequencyBucket[]`
 *     Bucketed by ISO week (Monday-start) × Theme; unnests
 *     `classifications.themes` (one row per Theme), counts.
 *
 * Reuses the seed helpers from `fake-dashboard-db.ts` so a test can seed
 * Reviews once and assert against both modules.
 */
import type { StarRatingTrendPoint, ThemeFrequencyBucket } from "@/db/queries/trends";
import type { ListReviewsFilters } from "@/db/queries/reviews";

import type { FakeDashboardState } from "./fake-dashboard-db";

interface TrendInput {
  businessId: string;
  filters?: ListReviewsFilters;
}

export function fakeGetStarRatingTrend(
  state: FakeDashboardState,
  input: TrendInput,
): StarRatingTrendPoint[] {
  const filters = input.filters ?? {};
  const connectionIds = new Set(
    state.sourceConnections.filter((sc) => sc.businessId === input.businessId).map((sc) => sc.id),
  );

  const filteredReviews = state.reviews.filter((review) => {
    if (!connectionIds.has(review.sourceConnectionId)) return false;
    if (
      filters.ratings &&
      filters.ratings.length > 0 &&
      !filters.ratings.includes(review.starRating)
    ) {
      return false;
    }
    if (filters.since && review.postedAt < filters.since) return false;
    if (filters.until && review.postedAt > filters.until) return false;
    if (filters.incidentsOnly) {
      const hasIncident = state.incidents.some((i) => i.reviewId === review.id);
      if (!hasIncident) return false;
    }
    return true;
  });

  // Bucket by UTC day.
  const buckets = new Map<string, { sum: number; count: number; date: Date }>();
  for (const review of filteredReviews) {
    const day = utcDayStart(review.postedAt);
    const key = day.toISOString();
    const existing = buckets.get(key);
    if (existing) {
      existing.sum += review.starRating;
      existing.count += 1;
    } else {
      buckets.set(key, { sum: review.starRating, count: 1, date: day });
    }
  }

  const sorted = Array.from(buckets.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
  const dayAvgs = sorted.map((b) => b.sum / b.count);

  // 30-row preceding window (29 preceding + current).
  return sorted.map((bucket, i) => {
    const windowStart = Math.max(0, i - 29);
    const windowSlice = dayAvgs.slice(windowStart, i + 1);
    const rollingAvg = windowSlice.reduce((acc, n) => acc + n, 0) / windowSlice.length;
    return {
      date: bucket.date,
      count: bucket.count,
      dayAvg: bucket.sum / bucket.count,
      rollingAvg,
    };
  });
}

export function fakeGetThemeFrequency(
  state: FakeDashboardState,
  input: TrendInput,
): ThemeFrequencyBucket[] {
  const filters = input.filters ?? {};
  const connectionIds = new Set(
    state.sourceConnections.filter((sc) => sc.businessId === input.businessId).map((sc) => sc.id),
  );

  const counts = new Map<string, { weekStart: Date; theme: string; count: number }>();
  for (const review of state.reviews) {
    if (!connectionIds.has(review.sourceConnectionId)) continue;
    if (
      filters.ratings &&
      filters.ratings.length > 0 &&
      !filters.ratings.includes(review.starRating)
    ) {
      continue;
    }
    if (filters.since && review.postedAt < filters.since) continue;
    if (filters.until && review.postedAt > filters.until) continue;
    if (filters.incidentsOnly) {
      const hasIncident = state.incidents.some((i) => i.reviewId === review.id);
      if (!hasIncident) continue;
    }
    const classification = state.classifications.find((c) => c.reviewId === review.id);
    // Production query uses INNER JOIN on classifications — unclassified
    // Reviews don't contribute.
    if (!classification) continue;
    const weekStart = isoWeekStart(review.postedAt);
    for (const theme of classification.themes) {
      const key = `${weekStart.toISOString()}|${theme}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { weekStart, theme, count: 1 });
      }
    }
  }

  return Array.from(counts.values()).sort((a, b) => {
    const t = a.weekStart.getTime() - b.weekStart.getTime();
    if (t !== 0) return t;
    return a.theme.localeCompare(b.theme);
  });
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Match Postgres' `date_trunc('week', ts)` semantics: ISO week starts on
 * Monday. Returns UTC midnight of that Monday.
 */
function isoWeekStart(d: Date): Date {
  const day = utcDayStart(d);
  // `getUTCDay()` returns 0 for Sunday, 1 for Monday, …, 6 for Saturday.
  const dow = day.getUTCDay();
  // Shift to the Monday of this ISO week: Sunday (0) -> -6, Monday (1) -> 0,
  // Tuesday (2) -> -1, etc.
  const delta = dow === 0 ? -6 : 1 - dow;
  day.setUTCDate(day.getUTCDate() + delta);
  return day;
}
