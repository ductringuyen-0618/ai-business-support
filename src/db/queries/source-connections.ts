/**
 * Read/write helpers for the `source_connections` table.
 *
 * Keeping these in one file gives later slices (slice 10's backfill handler,
 * future per-Source health views) one obvious place to find the SQL shape and
 * the encryption boundary. NO caller outside this module should touch the
 * encrypted-token columns directly — go through `upsertGoogleConnection` /
 * `disconnectSourceConnection` so the AES helpers are always applied.
 */
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { businesses, sourceConnections } from "@/db/schema";
import type { Business, SourceConnectionRow } from "@/db/schema";
import { encryptToken } from "@/lib/source-tokens/encrypt";

export interface UpsertGoogleConnectionInput {
  businessId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * Upsert a Google `source_connections` row keyed on (business_id, 'google').
 *
 * Re-running OAuth (e.g. after a disconnect, or after `errored`) hits the same
 * row and resets it to `healthy` / `backfill_status='pending'` so slice 10's
 * backfill worker picks it up again. We do NOT reset `loaded_count` on reconnect
 * — the existing Reviews stay; backfill is idempotent on `(source, source_review_id)`.
 */
export async function upsertGoogleConnection(
  input: UpsertGoogleConnectionInput,
): Promise<SourceConnectionRow> {
  const db = getDb();
  const encryptedAccess = encryptToken(input.accessToken);
  const encryptedRefresh = encryptToken(input.refreshToken);
  const rows = await db
    .insert(sourceConnections)
    .values({
      businessId: input.businessId,
      source: "google",
      oauthAccessToken: encryptedAccess,
      oauthRefreshToken: encryptedRefresh,
      oauthExpiresAt: input.expiresAt,
      status: "healthy",
      backfillStatus: "pending",
      // On a fresh connect we leave loaded_count at the column default (0).
      // On reconnect we don't touch it — the .set() below omits it.
    })
    .onConflictDoUpdate({
      target: [sourceConnections.businessId, sourceConnections.source],
      set: {
        oauthAccessToken: encryptedAccess,
        oauthRefreshToken: encryptedRefresh,
        oauthExpiresAt: input.expiresAt,
        status: "healthy",
        backfillStatus: "pending",
        disconnectedAt: null,
      },
    })
    .returning();
  // Drizzle returns an empty array if nothing was returned, which shouldn't
  // happen for an upsert — guard so callers can rely on the row.
  const row = rows[0];
  if (!row) {
    throw new Error(
      `source_connections upsert returned no row for business_id=${input.businessId}`,
    );
  }
  return row;
}

export async function getSourceConnectionsForBusiness(
  businessId: string,
): Promise<SourceConnectionRow[]> {
  const db = getDb();
  return db.select().from(sourceConnections).where(eq(sourceConnections.businessId, businessId));
}

export async function getSourceConnectionById(id: string): Promise<SourceConnectionRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(sourceConnections)
    .where(eq(sourceConnections.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A `source_connections` row joined to its owning Business. Used by the
 * `ingest_review` handler (slice 9) to assemble the Classifier's
 * `businessProfile` input without a second round-trip.
 */
export interface SourceConnectionWithBusiness {
  sourceConnection: SourceConnectionRow;
  business: Business;
}

/**
 * Find a `source_connections` row by id, joined to its owning Business.
 * Returns null if the row has vanished between enqueue and dispatch (e.g.
 * Business cancelled mid-backfill).
 */
export async function findSourceConnectionWithBusiness(
  id: string,
): Promise<SourceConnectionWithBusiness | null> {
  const db = getDb();
  const rows = await db
    .select({
      sourceConnection: sourceConnections,
      business: businesses,
    })
    .from(sourceConnections)
    .innerJoin(businesses, eq(sourceConnections.businessId, businesses.id))
    .where(eq(sourceConnections.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Slice 10: look up a connection by its Google `locationId`. Used by the
 * Pub/Sub webhook to map an incoming `{ accountId, locationId, ... }`
 * notification onto a SourceConnection so we know which Business / tokens to
 * use when fetching the new Reviews.
 *
 * Returns null if no connection has been linked to that location yet — which
 * is the correct response for slice 10 because the follow-up that populates
 * `google_location_id` from the OAuth callback hasn't landed (the column is
 * nullable). Callers should 204 in that case rather than retry.
 */
export async function getSourceConnectionByGoogleLocationId(
  googleLocationId: string,
): Promise<SourceConnectionRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(sourceConnections)
    .where(eq(sourceConnections.googleLocationId, googleLocationId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Slice 10: backfill progress writer. The backfill handler calls this once
 * after every page (so the slice-12 dashboard banner renders progressive
 * `loaded N of ~M`). Kept as a single helper so the SQL shape — including the
 * sentinel rules for `estimatedTotal` — stays in one place.
 *
 * `backfillStatus` is optional so callers can update counts mid-walk without
 * also flipping the status enum; pass `'running'` once at the start and
 * `'complete'` / `'failed'` at the end.
 */
export interface UpdateBackfillProgressInput {
  id: string;
  loadedCount?: number;
  estimatedTotal?: number;
  backfillStatus?: "pending" | "running" | "complete" | "failed";
  /** When set to `'errored'`, the slice-12 dashboard banner prompts re-auth. */
  status?: "pending" | "healthy" | "errored" | "disconnected";
}

export async function updateBackfillProgress(
  input: UpdateBackfillProgressInput,
): Promise<SourceConnectionRow | null> {
  const db = getDb();
  const set: Record<string, unknown> = {};
  if (input.loadedCount !== undefined) set.loadedCount = input.loadedCount;
  if (input.estimatedTotal !== undefined) set.estimatedTotal = input.estimatedTotal;
  if (input.backfillStatus !== undefined) set.backfillStatus = input.backfillStatus;
  if (input.status !== undefined) set.status = input.status;
  if (Object.keys(set).length === 0) {
    // Nothing to write — return the current row so callers can chain.
    return getSourceConnectionById(input.id);
  }
  const rows = await db
    .update(sourceConnections)
    .set(set)
    .where(eq(sourceConnections.id, input.id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Slice 10: atomically mark the "your dashboard is ready" email as sent for
 * this SourceConnection. Returns the updated row if we transitioned the flag
 * (i.e. the timestamp was previously null), or null if another worker already
 * set it. Callers use the null return to know "skip the send" — that gives us
 * one-and-only-one-send semantics even if two backfill jobs converge on the
 * final page concurrently.
 */
export async function markReadyEmailSent(id: string): Promise<SourceConnectionRow | null> {
  const db = getDb();
  const rows = await db
    .update(sourceConnections)
    .set({ readyEmailSentAt: new Date() })
    .where(and(eq(sourceConnections.id, id), sql`${sourceConnections.readyEmailSentAt} IS NULL`))
    .returning();
  return rows[0] ?? null;
}

/**
 * Mark a connection disconnected. Idempotent — calling on an already-
 * disconnected row is a no-op (the `where` still matches, but the `set` is
 * the same).
 *
 * Scoped by `businessId` to enforce that one Business can't disconnect another
 * Business's connection by guessing UUIDs.
 */
export async function disconnectSourceConnection(opts: {
  id: string;
  businessId: string;
}): Promise<SourceConnectionRow | null> {
  const db = getDb();
  const rows = await db
    .update(sourceConnections)
    .set({
      status: "disconnected",
      disconnectedAt: new Date(),
      oauthAccessToken: null,
      oauthRefreshToken: null,
      oauthExpiresAt: null,
    })
    .where(
      and(eq(sourceConnections.id, opts.id), eq(sourceConnections.businessId, opts.businessId)),
    )
    .returning();
  return rows[0] ?? null;
}
