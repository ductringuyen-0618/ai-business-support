/**
 * `POST /api/reviews/reclassify-failed`
 *
 * Operator-initiated retry of Classifier failures (slice 12, issue #14).
 *
 * Triggered by the dashboard's "Reclassify N failed" banner whenever
 * `countUnclassifiedReviewsForBusiness > 0`. We re-enqueue an `ingest_review`
 * job for each such Review — the handler will re-run the Redactor +
 * Classifier path and write the missing Classification row on success.
 *
 * Scope: capped at 100 rows per click (see `listUnclassifiedReviewsForBusiness`).
 * If the Business has more failed Reviews than the cap, a second click
 * processes the next batch. The cap keeps the request handler bounded so a
 * runaway failure mode (e.g. Anthropic outage backed up to thousands of
 * Reviews) can't time out the HTTP request.
 *
 * Authorisation: every Review re-enqueued must belong to a SourceConnection
 * owned by the calling Operator's Business. `listUnclassifiedReviewsForBusiness`
 * enforces that predicate in the SQL `WHERE` clause.
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { listUnclassifiedReviewsForBusiness } from "@/db/queries/reviews";
import { enqueueIngestReview } from "@/queue/boss";

export const runtime = "nodejs";

const RECLASSIFY_BATCH_CAP = 100;

export async function POST(_request: Request) {
  const { userId } = await auth();
  if (!userId) return new NextResponse(null, { status: 401 });

  const membership = await getOperatorWithBusinessByClerkUserId(userId);
  if (!membership) return new NextResponse(null, { status: 403 });

  const failed = await listUnclassifiedReviewsForBusiness(
    membership.business.id,
    RECLASSIFY_BATCH_CAP,
  );

  let enqueued = 0;
  for (const review of failed) {
    // Re-build the `raw_review` payload from the persisted Review row. We
    // already lost the original `google.update_time` / `google.review_reply`
    // because they weren't persisted, but the downstream handler only needs
    // the Reviewer's text + stars + posted_at + ids to re-classify. The
    // upsert in step 4 of the handler is a no-op on these existing rows
    // (idempotent on `(source, source_review_id)`) so we don't bloat data.
    await enqueueIngestReview({
      source_connection_id: review.sourceConnectionId,
      raw_review: {
        source_review_id: review.sourceReviewId,
        star_rating: review.starRating,
        review_text: review.reviewText,
        reviewer_display_name: review.reviewerDisplayName,
        posted_at: review.postedAt,
      },
    });
    enqueued += 1;
  }

  return NextResponse.json({ enqueued });
}
