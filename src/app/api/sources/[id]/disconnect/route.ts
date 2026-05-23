/**
 * `POST /api/sources/:id/disconnect`
 *
 * Operator-initiated disconnect of a `source_connections` row.
 *
 * Authorisation: the row must belong to the same Business as the calling
 * Operator. `disconnectSourceConnection` enforces the `business_id` predicate
 * server-side, so an attacker guessing UUIDs gets a 404 instead of mutating
 * someone else's row.
 *
 * Side effects:
 *   - `status` = 'disconnected'
 *   - `disconnected_at` = now()
 *   - token columns nulled (so any leaked DB dump no longer contains live
 *     OAuth tokens for the now-disconnected Source)
 *
 * The row itself is kept so future reconnect via the same OAuth flow can
 * upsert into it without orphaning the Reviews referenced by it (slice 9 FK
 * is `ON DELETE CASCADE`, so deleting the row would also delete the Reviews —
 * not what an Operator who toggles "Disconnect" expects).
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { disconnectSourceConnection } from "@/db/queries/source-connections";

export const runtime = "nodejs";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return new NextResponse(null, { status: 401 });

  const membership = await getOperatorWithBusinessByClerkUserId(userId);
  if (!membership) return new NextResponse(null, { status: 403 });

  const { id } = await ctx.params;
  if (!isUuid(id)) return new NextResponse(null, { status: 400 });

  const row = await disconnectSourceConnection({
    id,
    businessId: membership.business.id,
  });
  if (!row) return new NextResponse(null, { status: 404 });

  return new NextResponse(null, { status: 204 });
}

/**
 * Cheap UUID v4-ish check. We don't validate the version nibble strictly —
 * we just want to reject obviously-malformed input before it hits Postgres.
 */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
