/**
 * Integration-style tests for `src/db/queries/trends.ts`.
 *
 * Strategy: the fake-db (`fake-trends-db.ts`) mirrors the SQL semantics:
 * `date_trunc('day', ...)` bucketing, ISO-week (Monday-start) bucketing, and
 * the 30-day rolling-average window. The production code runs the same
 * predicates in Drizzle SQL; the fake is the test seam.
 *
 * AC pinned here (issue #15):
 *   - Star-rating trend rolls a 30-day window over per-day averages.
 *   - Theme frequency unnests `classifications.themes` and bucket-counts
 *     per (ISO week, Theme).
 *   - Both queries scope by Business id (multi-tenant isolation).
 *   - Both queries respect the shared filters: date range, star rating,
 *     incidents-only. (The Theme filter is intentionally NOT applied — see
 *     `buildTrendConditions` rationale in trends.ts.)
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  makeFakeDashboardState,
  seedClassification,
  seedIncident,
  seedReview,
  seedSourceConnection,
  type FakeDashboardState,
} from "./fake-dashboard-db";
import { fakeGetStarRatingTrend, fakeGetThemeFrequency } from "./fake-trends-db";

const BUSINESS_X = "11111111-1111-1111-1111-111111111111";
const BUSINESS_Y = "22222222-2222-2222-2222-222222222222";

let state: FakeDashboardState;

beforeEach(() => {
  state = makeFakeDashboardState();
});

describe("getStarRatingTrend", () => {
  it("buckets Reviews by UTC day and reports count + daily average", () => {
    const sc = seedSourceConnection(state, { businessId: BUSINESS_X });
    // Two Reviews on 2026-05-20 (avg 4), one on 2026-05-21 (5).
    seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "a",
      starRating: 3,
      postedAt: new Date("2026-05-20T08:00:00Z"),
    });
    seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "b",
      starRating: 5,
      postedAt: new Date("2026-05-20T20:00:00Z"),
    });
    seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "c",
      starRating: 5,
      postedAt: new Date("2026-05-21T10:00:00Z"),
    });

    const series = fakeGetStarRatingTrend(state, { businessId: BUSINESS_X });
    expect(series).toHaveLength(2);
    expect(series[0].date.toISOString().slice(0, 10)).toBe("2026-05-20");
    expect(series[0].count).toBe(2);
    expect(series[0].dayAvg).toBe(4);
    expect(series[1].date.toISOString().slice(0, 10)).toBe("2026-05-21");
    expect(series[1].count).toBe(1);
    expect(series[1].dayAvg).toBe(5);
  });

  it("computes the 30-day rolling average across the day series", () => {
    const sc = seedSourceConnection(state, { businessId: BUSINESS_X });
    // 35 consecutive days, rating = day index mod 5 + 1 — gives a clear
    // moving average we can spot-check.
    for (let i = 0; i < 35; i += 1) {
      const day = new Date("2026-04-01T12:00:00Z");
      day.setUTCDate(day.getUTCDate() + i);
      seedReview(state, {
        sourceConnectionId: sc.id,
        sourceReviewId: `r${i}`,
        starRating: (i % 5) + 1,
        postedAt: day,
      });
    }
    const series = fakeGetStarRatingTrend(state, { businessId: BUSINESS_X });
    expect(series).toHaveLength(35);
    // First day: rolling window only has one day -> equals dayAvg.
    expect(series[0].rollingAvg).toBe(series[0].dayAvg);
    // Day 30: window is days 1..30 inclusive (30 entries). Across 30
    // consecutive `(i % 5) + 1` values the mean works out to exactly 3.0.
    expect(series[29].rollingAvg).toBeCloseTo(3.0, 5);
  });

  it("does NOT leak another Business's Reviews", () => {
    const scX = seedSourceConnection(state, { businessId: BUSINESS_X });
    const scY = seedSourceConnection(state, { businessId: BUSINESS_Y });
    seedReview(state, {
      sourceConnectionId: scX.id,
      sourceReviewId: "x",
      starRating: 5,
      postedAt: new Date("2026-05-01T00:00:00Z"),
    });
    seedReview(state, {
      sourceConnectionId: scY.id,
      sourceReviewId: "y",
      starRating: 1,
      postedAt: new Date("2026-05-01T00:00:00Z"),
    });
    const series = fakeGetStarRatingTrend(state, { businessId: BUSINESS_X });
    expect(series).toHaveLength(1);
    expect(series[0].dayAvg).toBe(5);
  });

  it("respects the date-range filter", () => {
    const sc = seedSourceConnection(state, { businessId: BUSINESS_X });
    seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "a",
      starRating: 5,
      postedAt: new Date("2026-04-15T12:00:00Z"),
    });
    seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "b",
      starRating: 4,
      postedAt: new Date("2026-05-15T12:00:00Z"),
    });
    const series = fakeGetStarRatingTrend(state, {
      businessId: BUSINESS_X,
      filters: {
        since: new Date("2026-05-01T00:00:00Z"),
        until: new Date("2026-05-31T23:59:59Z"),
      },
    });
    expect(series).toHaveLength(1);
    expect(series[0].dayAvg).toBe(4);
  });

  it("respects the star-rating filter", () => {
    const sc = seedSourceConnection(state, { businessId: BUSINESS_X });
    seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "a",
      starRating: 1,
      postedAt: new Date("2026-05-15T12:00:00Z"),
    });
    seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "b",
      starRating: 5,
      postedAt: new Date("2026-05-15T12:00:00Z"),
    });
    const series = fakeGetStarRatingTrend(state, {
      businessId: BUSINESS_X,
      filters: { ratings: [5] },
    });
    expect(series).toHaveLength(1);
    expect(series[0].count).toBe(1);
    expect(series[0].dayAvg).toBe(5);
  });

  it("respects incidents-only filter", () => {
    const sc = seedSourceConnection(state, { businessId: BUSINESS_X });
    const a = seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "a",
      starRating: 1,
      postedAt: new Date("2026-05-15T12:00:00Z"),
    });
    seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "b",
      starRating: 1,
      postedAt: new Date("2026-05-15T12:00:00Z"),
    });
    seedIncident(state, { reviewId: a.id, businessId: BUSINESS_X });

    const series = fakeGetStarRatingTrend(state, {
      businessId: BUSINESS_X,
      filters: { incidentsOnly: true },
    });
    expect(series).toHaveLength(1);
    expect(series[0].count).toBe(1);
  });

  it("returns an empty series when no Reviews match", () => {
    seedSourceConnection(state, { businessId: BUSINESS_X });
    const series = fakeGetStarRatingTrend(state, { businessId: BUSINESS_X });
    expect(series).toEqual([]);
  });
});

describe("getThemeFrequency", () => {
  it("buckets by ISO week × Theme and counts unnested themes", () => {
    const sc = seedSourceConnection(state, { businessId: BUSINESS_X });
    // 2026-05-18 is a Monday — week of 2026-05-18.
    const a = seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "a",
      postedAt: new Date("2026-05-18T10:00:00Z"),
    });
    seedClassification(state, { reviewId: a.id, themes: ["service", "pricing"] });
    const b = seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "b",
      postedAt: new Date("2026-05-20T10:00:00Z"),
    });
    seedClassification(state, { reviewId: b.id, themes: ["service"] });
    // Next ISO week.
    const c = seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "c",
      postedAt: new Date("2026-05-25T10:00:00Z"),
    });
    seedClassification(state, { reviewId: c.id, themes: ["staff_attitude"] });

    const buckets = fakeGetThemeFrequency(state, { businessId: BUSINESS_X });
    // Expect: week 2026-05-18 has service:2 + pricing:1; week 2026-05-25
    // has staff_attitude:1. Sorted by (weekStart, theme) for stable order.
    expect(buckets).toEqual([
      { weekStart: new Date("2026-05-18T00:00:00Z"), theme: "pricing", count: 1 },
      { weekStart: new Date("2026-05-18T00:00:00Z"), theme: "service", count: 2 },
      { weekStart: new Date("2026-05-25T00:00:00Z"), theme: "staff_attitude", count: 1 },
    ]);
  });

  it("excludes unclassified Reviews (no classifications row -> no contribution)", () => {
    const sc = seedSourceConnection(state, { businessId: BUSINESS_X });
    seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "unclassified",
      postedAt: new Date("2026-05-18T10:00:00Z"),
    });
    const buckets = fakeGetThemeFrequency(state, { businessId: BUSINESS_X });
    expect(buckets).toEqual([]);
  });

  it("does not leak another Business's classifications", () => {
    const scX = seedSourceConnection(state, { businessId: BUSINESS_X });
    const scY = seedSourceConnection(state, { businessId: BUSINESS_Y });
    const a = seedReview(state, {
      sourceConnectionId: scX.id,
      sourceReviewId: "a",
      postedAt: new Date("2026-05-18T10:00:00Z"),
    });
    seedClassification(state, { reviewId: a.id, themes: ["service"] });
    const b = seedReview(state, {
      sourceConnectionId: scY.id,
      sourceReviewId: "b",
      postedAt: new Date("2026-05-18T10:00:00Z"),
    });
    seedClassification(state, { reviewId: b.id, themes: ["pricing"] });

    const buckets = fakeGetThemeFrequency(state, { businessId: BUSINESS_X });
    expect(buckets.map((b) => b.theme)).toEqual(["service"]);
  });

  it("respects the date-range filter", () => {
    const sc = seedSourceConnection(state, { businessId: BUSINESS_X });
    const inRange = seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "a",
      postedAt: new Date("2026-05-18T10:00:00Z"),
    });
    seedClassification(state, { reviewId: inRange.id, themes: ["service"] });
    const outOfRange = seedReview(state, {
      sourceConnectionId: sc.id,
      sourceReviewId: "b",
      postedAt: new Date("2026-04-01T10:00:00Z"),
    });
    seedClassification(state, { reviewId: outOfRange.id, themes: ["pricing"] });

    const buckets = fakeGetThemeFrequency(state, {
      businessId: BUSINESS_X,
      filters: {
        since: new Date("2026-05-01T00:00:00Z"),
        until: new Date("2026-05-31T23:59:59Z"),
      },
    });
    expect(buckets.map((b) => b.theme)).toEqual(["service"]);
  });

  it("returns an empty series when no Reviews match", () => {
    seedSourceConnection(state, { businessId: BUSINESS_X });
    const buckets = fakeGetThemeFrequency(state, { businessId: BUSINESS_X });
    expect(buckets).toEqual([]);
  });
});
