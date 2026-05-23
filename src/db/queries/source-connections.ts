/**
 * Read/write helpers for the `source_connections` table.
 *
 * Keeping these in one file gives later slices (slice 10's backfill handler,
 * future per-Source health views) one obvious place to find the SQL shape and
 * the encryption boundary. NO caller outside this module should touch the
 * encrypted-token columns directly — go through `upsertGoogleConnection` /
 * `disconnectSourceConnection` so the AES helpers are always applied.
 */
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { sourceConnections } from "@/db/schema";
import type { SourceConnectionRow } from "@/db/schema";
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
