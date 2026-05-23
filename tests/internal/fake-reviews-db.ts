/**
 * In-memory stand-in for the slice of state that the Deletion Request
 * endpoint touches: `reviews`, `source_connections` (for the business-scoping
 * join), and `classifications` (so tests can prove the row is intact after
 * a null-out).
 *
 * Same shape as `tests/webhooks/fake-db.ts`: tiny, hand-rolled, only models
 * the SQL operations our endpoint actually runs. Lives here rather than in
 * tests/webhooks/ because the touched tables don't overlap and copy-paste is
 * cheaper than coupling two test suites to one fake.
 */
import type { ClassificationRow, ReviewRow, SourceConnectionRow } from "@/db/schema";

export interface FakeState {
  sourceConnections: SourceConnectionRow[];
  reviews: ReviewRow[];
  classifications: ClassificationRow[];
}

let uuidCounter = 0;
function nextUuid(prefix: string): string {
  uuidCounter += 1;
  return `${prefix}-${uuidCounter.toString().padStart(8, "0")}-0000-0000-0000-000000000000`;
}

export function makeFakeState(): FakeState {
  return { sourceConnections: [], reviews: [], classifications: [] };
}

/**
 * Seed helpers — the Deletion Request tests want to read like
 * "Reviewer A has 3 Reviews in Business X", not like SQL fixtures.
 */
export function seedSourceConnection(
  state: FakeState,
  args: { businessId: string; source?: SourceConnectionRow["source"] },
): SourceConnectionRow {
  const row: SourceConnectionRow = {
    id: nextUuid("sc"),
    businessId: args.businessId,
    source: args.source ?? "google",
    oauthAccessToken: null,
    oauthRefreshToken: null,
    oauthExpiresAt: null,
    status: "healthy",
    backfillStatus: "complete",
    loadedCount: 0,
    estimatedTotal: null,
    createdAt: new Date(),
    disconnectedAt: null,
  };
  state.sourceConnections.push(row);
  return row;
}

export function seedReview(
  state: FakeState,
  args: {
    sourceConnectionId: string;
    sourceReviewId: string;
    reviewerDisplayName: string | null;
    reviewText: string | null;
    redactedText?: string;
    starRating?: number;
  },
): ReviewRow {
  const row: ReviewRow = {
    id: nextUuid("rev"),
    sourceConnectionId: args.sourceConnectionId,
    source: "google",
    sourceReviewId: args.sourceReviewId,
    starRating: args.starRating ?? 4,
    reviewText: args.reviewText,
    reviewerDisplayName: args.reviewerDisplayName,
    redactedText: args.redactedText ?? "<redacted>",
    postedAt: new Date("2026-05-01T12:00:00Z"),
    ingestedAt: new Date("2026-05-01T12:01:00Z"),
  };
  state.reviews.push(row);
  return row;
}

export function seedClassification(
  state: FakeState,
  args: { reviewId: string; themes?: string[]; isIncident?: boolean },
): ClassificationRow {
  const row: ClassificationRow = {
    reviewId: args.reviewId,
    promptVersion: "v1",
    isIncident: args.isIncident ?? false,
    severity: null,
    themes: args.themes ?? ["service"],
    sentiment: "neutral",
    suggestedReply: "Thanks for the feedback.",
    classifiedAt: new Date("2026-05-01T12:02:00Z"),
  };
  state.classifications.push(row);
  return row;
}

/**
 * In-memory implementation of `nullReviewerByBusiness`. Mirrors the contract
 * documented in `src/db/queries/reviews.ts`: scope by business via the
 * source_connections table; XOR on display name vs source review ids; null
 * `reviewText` + `reviewerDisplayName`; return affected count + matched ids.
 */
export function fakeNullReviewerByBusiness(
  state: FakeState,
  input: {
    businessId: string;
    reviewerDisplayName?: string;
    sourceReviewIds?: string[];
  },
): { affected: number; matchedIds: string[] } {
  const hasName = input.reviewerDisplayName !== undefined && input.reviewerDisplayName.length > 0;
  const hasIds = input.sourceReviewIds !== undefined && input.sourceReviewIds.length > 0;
  if (hasName === hasIds) {
    throw new Error(
      "fakeNullReviewerByBusiness: exactly one of reviewerDisplayName or sourceReviewIds must be provided",
    );
  }

  const connectionIds = new Set(
    state.sourceConnections.filter((sc) => sc.businessId === input.businessId).map((sc) => sc.id),
  );

  const matches = state.reviews.filter((r) => {
    if (!connectionIds.has(r.sourceConnectionId)) return false;
    if (hasName) {
      return r.reviewerDisplayName === input.reviewerDisplayName;
    }
    return (input.sourceReviewIds ?? []).includes(r.sourceReviewId);
  });

  for (const row of matches) {
    row.reviewText = null;
    row.reviewerDisplayName = null;
  }

  return {
    affected: matches.length,
    matchedIds: matches.map((r) => r.id),
  };
}
