/**
 * Integration-style tests for the slice-12 dashboard query layer.
 *
 * Strategy: the fake-db (`fake-dashboard-db.ts`) mirrors the SQL semantics of
 * `listReviewsForBusiness`, `countUnclassifiedReviewsForBusiness`,
 * `countUnresolvedIncidentsForBusiness`, and `markIncidentResolved`. We seed a
 * mixed Review / Classification / Incident set and assert the filter
 * narrowing behaviour that the dashboard depends on. The same predicates run
 * in production Drizzle — the fake is the test seam.
 *
 * AC pinned here (issue #14):
 *   - 25/page default + posted_at DESC ordering.
 *   - Theme filter narrows to Reviews tagged with at least one of the picked
 *     themes.
 *   - Date range narrows posted_at inclusively.
 *   - Star rating narrows to the picked ratings.
 *   - "Incidents only" narrows to Reviews that have an Incident row.
 *   - Multi-tenant isolation: another Business's Reviews never leak in.
 *   - countUnresolvedIncidents excludes resolved ones.
 *   - markIncidentResolved flips resolved_at and respects business scope.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  fakeCountUnclassifiedReviewsForBusiness,
  fakeCountUnresolvedIncidentsForBusiness,
  fakeListReviewsForBusiness,
  fakeMarkIncidentResolved,
  makeFakeDashboardState,
  seedClassification,
  seedIncident,
  seedReview,
  seedSourceConnection,
  type FakeDashboardState,
} from "./fake-dashboard-db";

const BUSINESS_X = "11111111-1111-1111-1111-111111111111";
const BUSINESS_Y = "22222222-2222-2222-2222-222222222222";

let state: FakeDashboardState;

beforeEach(() => {
  state = makeFakeDashboardState();
});

function seedMixedSet() {
  const scX = seedSourceConnection(state, { businessId: BUSINESS_X });
  const scY = seedSourceConnection(state, { businessId: BUSINESS_Y });

  // 10 Reviews in Business X across dates / ratings / themes.
  const reviewsData: Array<{
    id: string;
    rating: number;
    posted: string;
    themes: string[];
    incident?: boolean;
  }> = [
    { id: "r1", rating: 5, posted: "2026-05-20T10:00:00Z", themes: ["service"] },
    {
      id: "r2",
      rating: 1,
      posted: "2026-05-19T10:00:00Z",
      themes: ["staff_attitude"],
      incident: true,
    },
    { id: "r3", rating: 4, posted: "2026-05-18T10:00:00Z", themes: ["cleanliness"] },
    { id: "r4", rating: 2, posted: "2026-05-17T10:00:00Z", themes: ["wait_time", "service"] },
    { id: "r5", rating: 3, posted: "2026-05-15T10:00:00Z", themes: ["pricing"] },
    { id: "r6", rating: 5, posted: "2026-05-10T10:00:00Z", themes: ["product_quality"] },
    { id: "r7", rating: 1, posted: "2026-05-05T10:00:00Z", themes: ["service"] },
    { id: "r8", rating: 4, posted: "2026-04-25T10:00:00Z", themes: ["accessibility"] },
    { id: "r9", rating: 3, posted: "2026-04-15T10:00:00Z", themes: ["other"] },
    { id: "r10", rating: 2, posted: "2026-03-01T10:00:00Z", themes: ["service", "pricing"] },
  ];

  for (const r of reviewsData) {
    const reviewRow = seedReview(state, {
      sourceConnectionId: scX.id,
      sourceReviewId: r.id,
      starRating: r.rating,
      postedAt: new Date(r.posted),
    });
    seedClassification(state, {
      reviewId: reviewRow.id,
      themes: r.themes,
      isIncident: r.incident === true,
      severity: r.incident ? "high" : null,
    });
    if (r.incident) {
      seedIncident(state, {
        reviewId: reviewRow.id,
        businessId: BUSINESS_X,
        severity: "high",
        resolvedAt: null,
      });
    }
  }

  // One Review in Business Y to verify tenant isolation.
  const otherReview = seedReview(state, {
    sourceConnectionId: scY.id,
    sourceReviewId: "y1",
    starRating: 5,
    postedAt: new Date("2026-05-22T10:00:00Z"),
  });
  seedClassification(state, { reviewId: otherReview.id, themes: ["service"] });
}

describe("listReviewsForBusiness", () => {
  beforeEach(seedMixedSet);

  it("returns all 10 Reviews for the Business, ordered by posted_at DESC", () => {
    const result = fakeListReviewsForBusiness(state, { businessId: BUSINESS_X });
    expect(result.total).toBe(10);
    expect(result.rows).toHaveLength(10);
    // First row is the most recent.
    expect(result.rows[0].review.sourceReviewId).toBe("r1");
    expect(result.rows[result.rows.length - 1].review.sourceReviewId).toBe("r10");
  });

  it("does NOT leak Reviews from another Business", () => {
    const result = fakeListReviewsForBusiness(state, { businessId: BUSINESS_X });
    const sourceIds = result.rows.map((r) => r.review.sourceReviewId);
    expect(sourceIds).not.toContain("y1");
  });

  it("narrows by Theme — pulls only Reviews tagged with one of the chosen Themes", () => {
    const result = fakeListReviewsForBusiness(state, {
      businessId: BUSINESS_X,
      filters: { themes: ["service"] },
    });
    // r1 (service), r4 (wait_time, service), r7 (service), r10 (service, pricing).
    expect(result.rows.map((r) => r.review.sourceReviewId).sort()).toEqual([
      "r1",
      "r10",
      "r4",
      "r7",
    ]);
  });

  it("narrows by star rating (multi-select)", () => {
    const result = fakeListReviewsForBusiness(state, {
      businessId: BUSINESS_X,
      filters: { ratings: [1, 2] },
    });
    // r2, r4, r7, r10.
    expect(result.rows.map((r) => r.review.sourceReviewId).sort()).toEqual([
      "r10",
      "r2",
      "r4",
      "r7",
    ]);
  });

  it("narrows by date range (inclusive)", () => {
    const result = fakeListReviewsForBusiness(state, {
      businessId: BUSINESS_X,
      filters: {
        since: new Date("2026-05-01T00:00:00Z"),
        until: new Date("2026-05-31T23:59:59Z"),
      },
    });
    expect(result.rows.map((r) => r.review.sourceReviewId).sort()).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
    ]);
  });

  it("'incidents only' narrows to Reviews with an Incident row", () => {
    const result = fakeListReviewsForBusiness(state, {
      businessId: BUSINESS_X,
      filters: { incidentsOnly: true },
    });
    expect(result.rows.map((r) => r.review.sourceReviewId)).toEqual(["r2"]);
    expect(result.rows[0].incident).not.toBeNull();
  });

  it("combines multiple filters with AND semantics", () => {
    const result = fakeListReviewsForBusiness(state, {
      businessId: BUSINESS_X,
      filters: {
        themes: ["service"],
        ratings: [1, 2],
        since: new Date("2026-05-01T00:00:00Z"),
      },
    });
    // r4 (service, rating 2, 2026-05-17), r7 (service, rating 1, 2026-05-05).
    expect(result.rows.map((r) => r.review.sourceReviewId).sort()).toEqual(["r4", "r7"]);
  });

  it("paginates at perPage and exposes total separately", () => {
    const result = fakeListReviewsForBusiness(state, {
      businessId: BUSINESS_X,
      page: 2,
      perPage: 3,
    });
    expect(result.total).toBe(10);
    expect(result.rows).toHaveLength(3);
    // Page 2 of 3-per-page (offset 3) under DESC ordering starts at r4.
    expect(result.rows[0].review.sourceReviewId).toBe("r4");
  });

  it("hydrates the Classification + Incident on each row in one shape", () => {
    const result = fakeListReviewsForBusiness(state, {
      businessId: BUSINESS_X,
      filters: { incidentsOnly: true },
    });
    expect(result.rows[0].classification).not.toBeNull();
    expect(result.rows[0].classification!.themes).toEqual(["staff_attitude"]);
    expect(result.rows[0].incident).not.toBeNull();
    expect(result.rows[0].incident!.severity).toBe("high");
  });
});

describe("countUnclassifiedReviewsForBusiness", () => {
  it("counts Reviews that have NO Classification row", () => {
    const sc = seedSourceConnection(state, { businessId: BUSINESS_X });
    const a = seedReview(state, { sourceConnectionId: sc.id, sourceReviewId: "a" });
    seedClassification(state, { reviewId: a.id });
    seedReview(state, { sourceConnectionId: sc.id, sourceReviewId: "b" });
    seedReview(state, { sourceConnectionId: sc.id, sourceReviewId: "c" });
    expect(fakeCountUnclassifiedReviewsForBusiness(state, BUSINESS_X)).toBe(2);
  });

  it("returns 0 when every Review is classified", () => {
    const sc = seedSourceConnection(state, { businessId: BUSINESS_X });
    const a = seedReview(state, { sourceConnectionId: sc.id, sourceReviewId: "a" });
    seedClassification(state, { reviewId: a.id });
    expect(fakeCountUnclassifiedReviewsForBusiness(state, BUSINESS_X)).toBe(0);
  });

  it("does not count another Business's unclassified Reviews", () => {
    const scY = seedSourceConnection(state, { businessId: BUSINESS_Y });
    seedReview(state, { sourceConnectionId: scY.id, sourceReviewId: "y" });
    expect(fakeCountUnclassifiedReviewsForBusiness(state, BUSINESS_X)).toBe(0);
  });
});

describe("countUnresolvedIncidentsForBusiness", () => {
  beforeEach(seedMixedSet);

  it("returns 1 for the seeded Business (only the r2 Incident is unresolved)", () => {
    expect(fakeCountUnresolvedIncidentsForBusiness(state, BUSINESS_X)).toBe(1);
  });

  it("returns 0 once the only Incident is resolved", () => {
    const incident = state.incidents[0];
    incident.resolvedAt = new Date();
    expect(fakeCountUnresolvedIncidentsForBusiness(state, BUSINESS_X)).toBe(0);
  });

  it("does not count another Business's Incidents", () => {
    expect(fakeCountUnresolvedIncidentsForBusiness(state, BUSINESS_Y)).toBe(0);
  });
});

describe("markIncidentResolved", () => {
  beforeEach(seedMixedSet);

  it("sets resolved_at on the matching Incident", () => {
    const incident = state.incidents[0];
    expect(incident.resolvedAt).toBeNull();
    const updated = fakeMarkIncidentResolved(state, {
      id: incident.id,
      businessId: BUSINESS_X,
    });
    expect(updated).not.toBeNull();
    expect(updated!.resolvedAt).not.toBeNull();
  });

  it("returns null when the Incident belongs to a different Business (tenant isolation)", () => {
    const incident = state.incidents[0];
    const result = fakeMarkIncidentResolved(state, {
      id: incident.id,
      businessId: BUSINESS_Y,
    });
    expect(result).toBeNull();
    // The row was NOT updated.
    expect(state.incidents[0].resolvedAt).toBeNull();
  });

  it("returns null on an unknown Incident id", () => {
    expect(
      fakeMarkIncidentResolved(state, {
        id: "inc-deadbeef-0000-0000-0000-000000000000",
        businessId: BUSINESS_X,
      }),
    ).toBeNull();
  });
});
