/**
 * Read + write helpers for the `reviews` table.
 *
 * Kept as a thin module so the `ingest_review` job handler in
 * `src/queue/handlers/ingest-review.ts` has one obvious seam to mock — the
 * handler's unit tests inject a fake implementation of this module rather
 * than trying to fake Drizzle. The shape mirrors the contract documented in
 * issue #10 (idempotent upsert keyed on `(source, source_review_id)`).
 *
 * Both write helpers are idempotent: re-running with the same `(source,
 * source_review_id)` produces the same row id every time, which is the
 * property the backfill (slice 10) and live Pub/Sub (slice 10) paths both
 * depend on for safe retry.
 */
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db/client";
import { getNodeDb } from "@/db/node-client";
import { reviews, sourceConnections } from "@/db/schema";
import type { ReviewRow } from "@/db/schema";

export type ReviewSource = ReviewRow["source"];

export interface UpsertReviewInput {
  sourceConnectionId: string;
  source: ReviewSource;
  sourceReviewId: string;
  starRating: number;
  reviewText: string | null;
  reviewerDisplayName: string | null;
  redactedText: string;
  postedAt: Date;
}

/**
 * Upsert a Review keyed on `(source, source_review_id)`. Returns the row id —
 * either freshly assigned or the existing id, so the caller can write the
 * companion `classifications` row.
 *
 * We rely on the unique index `reviews_source_source_review_id_unique` plus
 * `onConflictDoUpdate` to make this a single round-trip; this is the
 * concurrency-safe choice if two workers process the same Review in parallel
 * (Pub/Sub + backfill overlap).
 */
export async function upsertReviewBySourceId(input: UpsertReviewInput): Promise<string> {
  const db = getNodeDb();
  // We re-write the non-key columns on conflict because a later page may
  // carry an edit (e.g. Reviewer corrected a typo). `ingested_at` stays as
  // the FIRST-time ingestion timestamp; we don't reset it on update.
  const [row] = await db
    .insert(reviews)
    .values({
      sourceConnectionId: input.sourceConnectionId,
      source: input.source,
      sourceReviewId: input.sourceReviewId,
      starRating: input.starRating,
      reviewText: input.reviewText,
      reviewerDisplayName: input.reviewerDisplayName,
      redactedText: input.redactedText,
      postedAt: input.postedAt,
    })
    .onConflictDoUpdate({
      target: [reviews.source, reviews.sourceReviewId],
      set: {
        sourceConnectionId: input.sourceConnectionId,
        starRating: input.starRating,
        reviewText: input.reviewText,
        reviewerDisplayName: input.reviewerDisplayName,
        redactedText: input.redactedText,
        postedAt: input.postedAt,
      },
    })
    .returning({ id: reviews.id });

  if (!row) {
    // `RETURNING` always emits a row for an INSERT … ON CONFLICT DO UPDATE,
    // so the only way to hit this is a driver / mock bug — surface it loudly.
    throw new Error("upsertReviewBySourceId: expected at least one row from RETURNING");
  }
  return row.id;
}

/**
 * Fetch a Review by `(source, source_review_id)`. Used by the handler unit
 * tests to assert the upsert wrote the expected fields; not currently used in
 * production code paths but kept here because the dashboard's "show by
 * Source id" link (slice 12) will need it.
 */
export async function findReviewBySourceId(
  source: ReviewSource,
  sourceReviewId: string,
): Promise<ReviewRow | null> {
  const db = getNodeDb();
  const rows = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.source, source), eq(reviews.sourceReviewId, sourceReviewId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
<<<<<<< HEAD
 * Input to the Deletion Request null-out (ADR-0006, slice 15).
 *
 * Exactly one of `reviewerDisplayName` / `sourceReviewIds` must be set; the
 * caller (the `/api/internal/deletion-request` route) rejects the XOR
 * violation at the HTTP layer before reaching this helper.
 *
 * `businessId` is mandatory and scopes every match — even an admin call can
 * never null out a Reviewer's rows across a different Business than the one
 * named in the support ticket. The endpoint relies on this for tenant safety;
 * the runbook tells operators to always pass `--business-id`.
 */
export interface NullReviewerByBusinessInput {
  businessId: string;
  reviewerDisplayName?: string;
  sourceReviewIds?: string[];
}

export interface NullReviewerByBusinessResult {
  /**
   * Number of rows the UPDATE matched. Idempotency note: a second invocation
   * on the same input still returns the same count, because the WHERE clause
   * matches the rows by `source_review_id` / business scope, not by "fields
   * still non-null". A row that's already nulled is re-set to null (a no-op
   * in effect, but counted as matched). The runbook documents this so
   * operators don't read a non-zero count as "more work happened".
   */
  affected: number;
  /**
   * The `reviews.id`s that were updated, in no particular order. Returned to
   * the caller so the runbook can paste them into the support ticket as the
   * audit artefact.
   */
  matchedIds: string[];
}

/**
 * Null `review_text` and `reviewer_display_name` on Reviews matching either a
 * Reviewer display name OR a list of `source_review_id`s — always within a
 * single Business. This is the Deletion Request honour-the-request primitive
 * (CONTEXT.md "Deletion Request", ADR-0006).
 *
 * Semantics:
 *   - The Review row itself is KEPT. Classification themes/severity/timestamp
 *     keep feeding the trend dashboard.
 *   - `redacted_text` is left as-is — that's the text Anthropic was shown, and
 *     it's already redacted at ingest. Re-redacting it here would be useless.
 *   - The whole UPDATE runs inside a single transaction so concurrent
 *     dashboard reads either see all matching rows pre-null or all post-null.
 *
 * Scoping: `reviews` has no `business_id` column — it FKs to
 * `source_connections`, which in turn FKs to `businesses`. We translate the
 * `businessId` filter into "source_connection_id IN (SELECT id FROM
 * source_connections WHERE business_id = ?)" so the predicate stays an
 * UPDATE-WHERE rather than needing a join (Drizzle's `.update(...).from(...)`
 * is awkward to mock).
 */
export async function nullReviewerByBusiness(
  input: NullReviewerByBusinessInput,
): Promise<NullReviewerByBusinessResult> {
  const hasName = input.reviewerDisplayName !== undefined && input.reviewerDisplayName.length > 0;
  const hasIds = input.sourceReviewIds !== undefined && input.sourceReviewIds.length > 0;
  if (hasName === hasIds) {
    // The HTTP layer enforces XOR with a 400 response. Surface a programmer
    // error if a future caller bypasses the route handler — we'd rather throw
    // than silently null out every Review in the Business.
    throw new Error(
      "nullReviewerByBusiness: exactly one of reviewerDisplayName or sourceReviewIds must be provided",
    );
  }

  const db = getDb();

  // Sub-select of source_connection_ids belonging to this Business. We compute
  // it once and feed it into the UPDATE predicate. Putting the join in a sub-
  // select keeps the UPDATE shape `.update(reviews).set(...).where(...)`,
  // which is the form covered by the fake-db in tests.
  const connectionIdRows = await db
    .select({ id: sourceConnections.id })
    .from(sourceConnections)
    .where(eq(sourceConnections.businessId, input.businessId));
  const connectionIds = connectionIdRows.map((r) => r.id);
  if (connectionIds.length === 0) {
    // No connections for this Business means no Reviews to update. Bail before
    // running an UPDATE with an `IN ()` clause (which is a SQL error).
    return { affected: 0, matchedIds: [] };
  }

  const matchPredicate = hasName
    ? and(
        inArray(reviews.sourceConnectionId, connectionIds),
        // Case-sensitive match — Deletion Requests must specify the exact
        // display name as it appears on the Review (the runbook tells the
        // support agent to copy/paste from the Reviewer's email).
        eq(reviews.reviewerDisplayName, input.reviewerDisplayName as string),
      )
    : and(
        inArray(reviews.sourceConnectionId, connectionIds),
        inArray(reviews.sourceReviewId, input.sourceReviewIds as string[]),
      );

  const updated = await db
    .update(reviews)
    .set({
      reviewText: null,
      reviewerDisplayName: null,
    })
    .where(matchPredicate)
    .returning({ id: reviews.id });

  return {
    affected: updated.length,
    matchedIds: updated.map((r) => r.id),
  };
}

/**
 * Lookup helper for the `fire_incident` handler (slice 11): given a Review id,
 * return the row plus the `business_id` it belongs to (joined via its
 * source_connection). Returns null if the Review has vanished (Business
 * cancelled mid-flight, or the source_connection was hard-deleted).
 */
export interface ReviewWithBusinessId extends ReviewRow {
  businessId: string;
}

export async function findReviewWithBusinessId(id: string): Promise<ReviewWithBusinessId | null> {
  const db = getNodeDb();
  const rows = await db
    .select({
      review: reviews,
      businessId: sourceConnections.businessId,
    })
    .from(reviews)
    .innerJoin(sourceConnections, eq(reviews.sourceConnectionId, sourceConnections.id))
    .where(eq(reviews.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row.review, businessId: row.businessId };
}
