/**
 * Read helpers used by the `compose_digest` job (slice 14).
 *
 * Pulls the inputs the Digest composer needs from the DB:
 *
 *   - The Business row (name + industry) for the prompt + email subject.
 *   - The classified Reviews in a given period for the Business.
 *   - The Business's reference timezone (operators[0].timezone for MVP per
 *     issue #16 AC — the first Operator's Email-channel pref, falling back
 *     to UTC if no rows).
 *   - The list of Operator email addresses to deliver the Digest to.
 *   - The list of active (not-cancelled) Businesses to survey hourly.
 *
 * The handler tests inject fakes for each of these via the DI seam, so this
 * module is essentially the side-effect boundary.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";

import { getNodeDb } from "@/db/node-client";
import {
  businesses,
  classifications,
  operatorChannelPrefs,
  operators,
  reviews,
  sourceConnections,
  type Business,
  type ClassificationRow,
  type ReviewRow,
} from "@/db/schema";

/**
 * List active Businesses — i.e. not cancelled. The hourly enqueuer iterates
 * this set and decides per-Business whether to emit a `compose_digest` job
 * based on the local-clock check.
 */
export async function listActiveBusinesses(): Promise<Business[]> {
  const db = getNodeDb();
  return db.select().from(businesses).where(isNull(businesses.cancelledAt));
}

/**
 * Find one Business by id; null if missing or cancelled.
 */
export async function findActiveBusinessById(businessId: string): Promise<Business | null> {
  const db = getNodeDb();
  const rows = await db
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, businessId), isNull(businesses.cancelledAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve the Business's reference timezone for the Digest schedule.
 *
 * Per issue #16: "use operators[0].timezone as the Business's reference
 * timezone for MVP". We pick the email-channel pref row of the first Operator
 * by creation date — that row's `timezone` is the IANA zone we treat as the
 * Business's local clock for Monday-08:00-local enqueueing.
 *
 * Returns "UTC" if no Operator has any pref row yet (a brand-new Business).
 * That makes the enqueuer behave deterministically rather than skipping the
 * Business entirely.
 */
export async function findBusinessReferenceTimezone(businessId: string): Promise<string> {
  const db = getNodeDb();
  const rows = await db
    .select({ timezone: operatorChannelPrefs.timezone })
    .from(operators)
    .innerJoin(operatorChannelPrefs, eq(operatorChannelPrefs.operatorId, operators.id))
    .where(and(eq(operators.businessId, businessId), isNull(operators.deletedAt)))
    .orderBy(operators.createdAt)
    .limit(1);
  return rows[0]?.timezone ?? "UTC";
}

/**
 * Email addresses for every active Operator at a Business. Used by the
 * `compose_digest` handler to fan the Digest out. Soft-deleted Operators are
 * filtered.
 */
export async function findActiveOperatorEmailsForBusiness(businessId: string): Promise<string[]> {
  const db = getNodeDb();
  const rows = await db
    .select({ email: operators.email })
    .from(operators)
    .where(
      and(
        eq(operators.businessId, businessId),
        isNull(operators.deletedAt),
        // Defensive — operators.email is NOT NULL, but a future change might
        // relax it. Still cheap to filter here.
        isNotNull(operators.email),
        ne(operators.email, ""),
      ),
    );
  return rows.map((r) => r.email);
}

/**
 * Joined Review + Classification row, scoped to a single Business via the
 * source_connection FK. Returned in `posted_at` ascending order so callers
 * can compute Theme-movement deltas with positional iteration if needed.
 */
export interface ClassifiedReviewRow {
  review: ReviewRow;
  classification: ClassificationRow;
}

export async function findClassifiedReviewsForBusinessInPeriod(input: {
  businessId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<ClassifiedReviewRow[]> {
  const db = getNodeDb();

  // Translate businessId -> source_connection_ids (reviews has no business_id
  // column; it FKs to source_connections which FKs to businesses).
  const connectionIdRows = await db
    .select({ id: sourceConnections.id })
    .from(sourceConnections)
    .where(eq(sourceConnections.businessId, input.businessId));
  const connectionIds = connectionIdRows.map((r) => r.id);
  if (connectionIds.length === 0) return [];

  const rows = await db
    .select({
      review: reviews,
      classification: classifications,
    })
    .from(reviews)
    .innerJoin(classifications, eq(classifications.reviewId, reviews.id))
    .where(
      and(
        inArray(reviews.sourceConnectionId, connectionIds),
        gte(reviews.postedAt, input.periodStart),
        lt(reviews.postedAt, input.periodEnd),
      ),
    )
    .orderBy(sql`${reviews.postedAt} ASC`);

  return rows.map((r) => ({ review: r.review, classification: r.classification }));
}
