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
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { getNodeDb } from "@/db/node-client";
import { classifications, incidents, reviews, sourceConnections } from "@/db/schema";
import type { ClassificationRow, IncidentRow, ReviewRow } from "@/db/schema";

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

// ---------------------------------------------------------------------------
// Slice 12: dashboard read helpers.
// ---------------------------------------------------------------------------

/**
 * Filter spec consumed by `listReviewsForBusiness`. Mirrors the URL-serialised
 * `DashboardFilters` in `src/app/app/dashboard/_components/filters.ts` but in
 * resolved form — date presets have been expanded to absolute `since` / `until`
 * by the caller, so this layer is decoupled from the "last_7_days" sugar and
 * can be reused by any future caller that wants absolute boundaries.
 */
export interface ListReviewsFilters {
  themes?: string[];
  ratings?: number[];
  since?: Date;
  until?: Date;
  incidentsOnly?: boolean;
}

export interface ListReviewsInput {
  businessId: string;
  filters?: ListReviewsFilters;
  page?: number;
  perPage?: number;
}

/**
 * One row in the dashboard's review list: the Review + its Classification (if
 * any — Classifier failures leave it null) + a flag for "this Review has an
 * unresolved Incident". The flag is computed in SQL so the dashboard can show
 * the Incident pill without a second round-trip per row.
 */
export interface ReviewListRow {
  review: ReviewRow;
  classification: ClassificationRow | null;
  incident: IncidentRow | null;
}

export interface ListReviewsResult {
  rows: ReviewListRow[];
  total: number;
}

/**
 * Paginated Review list for the dashboard.
 *
 * Scoping: every row must belong to a SourceConnection owned by `businessId`.
 * That predicate is the multi-tenant isolation guarantee per ADR-0009 — the
 * route handler resolves the Operator's `business_id` from the Clerk session
 * and passes it in; the SQL filters never see another Business's data.
 *
 * Theme filtering: `classifications.themes` is a `jsonb` array column. We use
 * the `?|` operator (jsonb contains ANY of the keys) which is index-friendly
 * if a GIN index is added later but already correct without one — and there's
 * no efficient way to do this with drizzle-orm's typed helpers, so we drop to
 * raw SQL via `sql\`\`` for that one predicate.
 *
 * `incidents_only=true` becomes an INNER JOIN (filters out rows without an
 * Incident); the default path is a LEFT JOIN so non-Incident Reviews still
 * render. `resolved_at IS NOT NULL` rows still appear in the list — the AC
 * says "Incidents only", not "unresolved Incidents only", so the toggle is
 * about "is this Review an Incident at all".
 *
 * Performance: one query for the page rows + one COUNT query — two round
 * trips total. We chose two queries over a single window-function query
 * because it keeps the SQL portable across `neon-http` (which is happier with
 * simple statements) and easier to test against the same fake-db that the
 * other repository helpers use.
 */
export async function listReviewsForBusiness(input: ListReviewsInput): Promise<ListReviewsResult> {
  const db = getDb();
  const page = input.page && input.page >= 1 ? input.page : 1;
  const perPage = input.perPage && input.perPage >= 1 ? input.perPage : 25;
  const filters = input.filters ?? {};

  const conditions = buildReviewConditions(input.businessId, filters);

  // Row query: pull Reviews + (left join) classifications + (left join)
  // incidents in one round-trip. The incidents join is unconditional — the
  // "incidents only" toggle becomes an additional WHERE predicate rather
  // than a JOIN flavour-switch, which keeps the query shape stable.
  const rowsRaw = await db
    .select({
      review: reviews,
      classification: classifications,
      incident: incidents,
    })
    .from(reviews)
    .innerJoin(sourceConnections, eq(reviews.sourceConnectionId, sourceConnections.id))
    .leftJoin(classifications, eq(classifications.reviewId, reviews.id))
    .leftJoin(incidents, eq(incidents.reviewId, reviews.id))
    .where(conditions)
    .orderBy(desc(reviews.postedAt))
    .limit(perPage)
    .offset((page - 1) * perPage);

  // Count query: same predicate, no joins beyond what the WHERE needs. We
  // join classifications + incidents here too because the WHERE may
  // reference their columns (themes filter / incidentsOnly).
  const totalRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviews)
    .innerJoin(sourceConnections, eq(reviews.sourceConnectionId, sourceConnections.id))
    .leftJoin(classifications, eq(classifications.reviewId, reviews.id))
    .leftJoin(incidents, eq(incidents.reviewId, reviews.id))
    .where(conditions);
  const total = totalRows[0]?.n ?? 0;

  return {
    rows: rowsRaw.map((r) => ({
      review: r.review,
      classification: r.classification,
      incident: r.incident,
    })),
    total,
  };
}

function buildReviewConditions(businessId: string, filters: ListReviewsFilters) {
  const parts = [eq(sourceConnections.businessId, businessId)];

  if (filters.ratings && filters.ratings.length > 0) {
    parts.push(inArray(reviews.starRating, filters.ratings));
  }
  if (filters.since) {
    parts.push(gte(reviews.postedAt, filters.since));
  }
  if (filters.until) {
    parts.push(lte(reviews.postedAt, filters.until));
  }
  if (filters.themes && filters.themes.length > 0) {
    // `?|` is the jsonb "contains any of these top-level keys" operator —
    // perfect for a string array, since each Theme is stored as a JSON
    // string element. The array literal is parameterised so injection
    // surface is zero (drizzle binds the array as text[]).
    parts.push(
      sql`${classifications.themes} ?| ${sql.raw(`array[${filters.themes.map((t) => `'${escapeLit(t)}'`).join(",")}]::text[]`)}`,
    );
  }
  if (filters.incidentsOnly) {
    parts.push(isNotNull(incidents.id));
  }

  return and(...parts);
}

/**
 * Sanitise a Theme string for inline SQL inclusion. The Theme list is a fixed
 * enum coming from `THEMES` in the Classifier schema, but we still belt-and-
 * braces here because (a) the caller is the URL-derived filter parser and
 * (b) a future bug that allows arbitrary strings should not turn into a
 * SQL-injection bug. We allow `[a-z_]` only.
 */
function escapeLit(value: string): string {
  if (!/^[a-z_]+$/.test(value)) {
    throw new Error(`reviews:listReviewsForBusiness — refusing unsafe theme literal: ${value}`);
  }
  return value;
}

/**
 * Count of Reviews owned by this Business that have NO Classification row
 * yet — i.e. the Classifier failed past pg-boss retries (see slice 9). The
 * dashboard renders a "reclassify N failed" banner whenever this is > 0.
 *
 * Returned as a plain number; the banner only needs the count, not the row
 * ids — the "reclassify failed" route looks up the ids itself.
 */
export async function countUnclassifiedReviewsForBusiness(businessId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviews)
    .innerJoin(sourceConnections, eq(reviews.sourceConnectionId, sourceConnections.id))
    .leftJoin(classifications, eq(classifications.reviewId, reviews.id))
    .where(and(eq(sourceConnections.businessId, businessId), isNull(classifications.reviewId)));
  return rows[0]?.n ?? 0;
}

/**
 * Fetch unclassified Reviews owned by `businessId`, capped at `limit` so the
 * "reclassify failed" route can fan them out into `ingest_review` jobs
 * without blowing up if the table is huge. The cap is intentional: the AC
 * is "reclassify N failed", not "reclassify EVERY failed forever in one
 * click" — a second click handles the remainder.
 */
export async function listUnclassifiedReviewsForBusiness(
  businessId: string,
  limit = 100,
): Promise<ReviewRow[]> {
  const db = getDb();
  const rows = await db
    .select({ review: reviews })
    .from(reviews)
    .innerJoin(sourceConnections, eq(reviews.sourceConnectionId, sourceConnections.id))
    .leftJoin(classifications, eq(classifications.reviewId, reviews.id))
    .where(and(eq(sourceConnections.businessId, businessId), isNull(classifications.reviewId)))
    .limit(limit);
  return rows.map((r) => r.review);
}

/**
 * Fetch a single Review for the drawer, scoped to a Business and pre-joined
 * with its Classification + Incident (if any). Returns null on no-match (or
 * on a Review owned by another Business — the join + WHERE enforces tenant
 * scoping).
 */
export async function findReviewDetailForBusiness(
  businessId: string,
  reviewId: string,
): Promise<ReviewListRow | null> {
  const db = getDb();
  const rows = await db
    .select({
      review: reviews,
      classification: classifications,
      incident: incidents,
    })
    .from(reviews)
    .innerJoin(sourceConnections, eq(reviews.sourceConnectionId, sourceConnections.id))
    .leftJoin(classifications, eq(classifications.reviewId, reviews.id))
    .leftJoin(incidents, eq(incidents.reviewId, reviews.id))
    .where(and(eq(reviews.id, reviewId), eq(sourceConnections.businessId, businessId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { review: row.review, classification: row.classification, incident: row.incident };
}
