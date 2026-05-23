/**
 * In-memory stand-in for the slice-12 dashboard query layer.
 *
 * Mirrors the contract of:
 *   - `src/db/queries/reviews.ts#listReviewsForBusiness`
 *   - `src/db/queries/reviews.ts#countUnclassifiedReviewsForBusiness`
 *   - `src/db/queries/incidents.ts#countUnresolvedIncidentsForBusiness`
 *   - `src/db/queries/incidents.ts#markIncidentResolved`
 *
 * Same shape as `tests/internal/fake-reviews-db.ts`: the integration test
 * exercises the SQL-shaped semantics (filter narrowing, scoping, ordering)
 * against the in-memory implementation. The production code path uses the
 * same Drizzle SQL that this fake mirrors. The fake keeps the slice's
 * integration tests fast + portable while pinning the contract.
 */
import type { ClassificationRow, IncidentRow, ReviewRow, SourceConnectionRow } from "@/db/schema";
import type { ListReviewsFilters, ListReviewsResult, ReviewListRow } from "@/db/queries/reviews";

export interface FakeDashboardState {
  sourceConnections: SourceConnectionRow[];
  reviews: ReviewRow[];
  classifications: ClassificationRow[];
  incidents: IncidentRow[];
}

let uuidCounter = 0;
function nextUuid(prefix: string): string {
  uuidCounter += 1;
  return `${prefix}-${uuidCounter.toString().padStart(8, "0")}-0000-0000-0000-000000000000`;
}

export function makeFakeDashboardState(): FakeDashboardState {
  return { sourceConnections: [], reviews: [], classifications: [], incidents: [] };
}

export function seedSourceConnection(
  state: FakeDashboardState,
  args: { businessId: string },
): SourceConnectionRow {
  const row: SourceConnectionRow = {
    id: nextUuid("sc"),
    businessId: args.businessId,
    source: "google",
    oauthAccessToken: null,
    oauthRefreshToken: null,
    oauthExpiresAt: null,
    status: "healthy",
    backfillStatus: "complete",
    loadedCount: 0,
    estimatedTotal: null,
    googleLocationId: null,
    readyEmailSentAt: null,
    createdAt: new Date(),
    disconnectedAt: null,
  };
  state.sourceConnections.push(row);
  return row;
}

export function seedReview(
  state: FakeDashboardState,
  args: {
    sourceConnectionId: string;
    sourceReviewId: string;
    starRating?: number;
    postedAt?: Date;
    reviewerDisplayName?: string | null;
    reviewText?: string | null;
  },
): ReviewRow {
  const row: ReviewRow = {
    id: nextUuid("rev"),
    sourceConnectionId: args.sourceConnectionId,
    source: "google",
    sourceReviewId: args.sourceReviewId,
    starRating: args.starRating ?? 4,
    reviewText: args.reviewText ?? "Lovely place.",
    reviewerDisplayName: args.reviewerDisplayName ?? "Reviewer",
    redactedText: "<redacted>",
    postedAt: args.postedAt ?? new Date("2026-05-01T12:00:00Z"),
    ingestedAt: new Date("2026-05-01T12:01:00Z"),
  };
  state.reviews.push(row);
  return row;
}

export function seedClassification(
  state: FakeDashboardState,
  args: { reviewId: string; themes?: string[]; isIncident?: boolean; severity?: string | null },
): ClassificationRow {
  const row: ClassificationRow = {
    reviewId: args.reviewId,
    promptVersion: "v1",
    isIncident: args.isIncident ?? false,
    severity: args.severity ?? null,
    themes: args.themes ?? ["service"],
    sentiment: "neutral",
    suggestedReply: "Thanks for the feedback.",
    classifiedAt: new Date("2026-05-01T12:02:00Z"),
  };
  state.classifications.push(row);
  return row;
}

export function seedIncident(
  state: FakeDashboardState,
  args: { reviewId: string; businessId: string; severity?: string; resolvedAt?: Date | null },
): IncidentRow {
  const row: IncidentRow = {
    id: nextUuid("inc"),
    reviewId: args.reviewId,
    businessId: args.businessId,
    severity: args.severity ?? "high",
    firedAt: new Date("2026-05-01T12:03:00Z"),
    resolvedAt: args.resolvedAt ?? null,
  };
  state.incidents.push(row);
  return row;
}

/**
 * In-memory list-reviews matching the production query's predicate set:
 *   - Scope by business_id via source_connections.
 *   - Star-rating IN.
 *   - posted_at >= since / <= until.
 *   - jsonb themes intersect filter themes.
 *   - incidentsOnly: row must have an incident.
 * Ordered by posted_at DESC. Paginated.
 */
export function fakeListReviewsForBusiness(
  state: FakeDashboardState,
  input: {
    businessId: string;
    filters?: ListReviewsFilters;
    page?: number;
    perPage?: number;
  },
): ListReviewsResult {
  const filters = input.filters ?? {};
  const page = input.page ?? 1;
  const perPage = input.perPage ?? 25;

  const connectionIds = new Set(
    state.sourceConnections.filter((sc) => sc.businessId === input.businessId).map((sc) => sc.id),
  );

  const matched: ReviewListRow[] = [];
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

    const classification = state.classifications.find((c) => c.reviewId === review.id) ?? null;
    if (filters.themes && filters.themes.length > 0) {
      const cls = classification;
      if (!cls) continue;
      const hasIntersection = cls.themes.some((t) => filters.themes!.includes(t));
      if (!hasIntersection) continue;
    }

    const incident = state.incidents.find((i) => i.reviewId === review.id) ?? null;
    if (filters.incidentsOnly && !incident) continue;

    matched.push({ review, classification, incident });
  }

  matched.sort((a, b) => b.review.postedAt.getTime() - a.review.postedAt.getTime());
  const total = matched.length;
  const start = (page - 1) * perPage;
  const rows = matched.slice(start, start + perPage);
  return { rows, total };
}

export function fakeCountUnclassifiedReviewsForBusiness(
  state: FakeDashboardState,
  businessId: string,
): number {
  const connectionIds = new Set(
    state.sourceConnections.filter((sc) => sc.businessId === businessId).map((sc) => sc.id),
  );
  return state.reviews.filter(
    (r) =>
      connectionIds.has(r.sourceConnectionId) &&
      !state.classifications.some((c) => c.reviewId === r.id),
  ).length;
}

export function fakeCountUnresolvedIncidentsForBusiness(
  state: FakeDashboardState,
  businessId: string,
): number {
  return state.incidents.filter((i) => i.businessId === businessId && i.resolvedAt === null).length;
}

export function fakeMarkIncidentResolved(
  state: FakeDashboardState,
  opts: { id: string; businessId: string },
  now: Date = new Date(),
): IncidentRow | null {
  const row = state.incidents.find((i) => i.id === opts.id && i.businessId === opts.businessId);
  if (!row) return null;
  row.resolvedAt = now;
  return row;
}
