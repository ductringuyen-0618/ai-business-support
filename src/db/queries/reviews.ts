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
import { and, eq } from "drizzle-orm";

import { getNodeDb } from "@/db/node-client";
import { reviews } from "@/db/schema";
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
