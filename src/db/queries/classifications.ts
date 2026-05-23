/**
 * Read + write helpers for the `classifications` table.
 *
 * Companion to `./reviews.ts`. The `classifications` row is keyed by
 * `review_id` and is written ONCE per Review per prompt version — when the
 * prompt is bumped (ADR-0004) we re-run the Classifier and overwrite the
 * existing row rather than versioning rows. The dashboard reads "the
 * classification for this Review" as a 1:1 join; that invariant is enforced
 * by the PK on `review_id`.
 */
import { eq } from "drizzle-orm";

import { getNodeDb } from "@/db/node-client";
import { classifications } from "@/db/schema";
import type { ClassificationRow } from "@/db/schema";

export interface UpsertClassificationInput {
  reviewId: string;
  promptVersion: string;
  isIncident: boolean;
  severity: "low" | "medium" | "high" | null;
  themes: string[];
  sentiment: string;
  suggestedReply: string;
}

/**
 * Upsert the Classification for a Review. The primary key on `review_id`
 * ensures we never have two Classifications for the same Review; re-running
 * the handler with a fresh Classifier output (e.g. retry after a Zod failure
 * the next attempt) overwrites cleanly.
 *
 * `classified_at` is reset on every write — the row's value reflects "when
 * was this Classification produced", not "when was the Review first seen".
 */
export async function upsertClassification(input: UpsertClassificationInput): Promise<void> {
  const db = getNodeDb();
  const now = new Date();
  await db
    .insert(classifications)
    .values({
      reviewId: input.reviewId,
      promptVersion: input.promptVersion,
      isIncident: input.isIncident,
      severity: input.severity,
      themes: input.themes,
      sentiment: input.sentiment,
      suggestedReply: input.suggestedReply,
      classifiedAt: now,
    })
    .onConflictDoUpdate({
      target: classifications.reviewId,
      set: {
        promptVersion: input.promptVersion,
        isIncident: input.isIncident,
        severity: input.severity,
        themes: input.themes,
        sentiment: input.sentiment,
        suggestedReply: input.suggestedReply,
        classifiedAt: now,
      },
    });
}

/**
 * Lookup helper for tests + slice-12 dashboard queries.
 */
export async function findClassificationByReviewId(
  reviewId: string,
): Promise<ClassificationRow | null> {
  const db = getNodeDb();
  const rows = await db
    .select()
    .from(classifications)
    .where(eq(classifications.reviewId, reviewId))
    .limit(1);
  return rows[0] ?? null;
}
