/**
 * `POST /api/incidents/:id/resolve`
 *
 * Operator-initiated "Mark resolved" for an Incident (slice 12, issue #14).
 *
 * Authorisation: the Incident's `business_id` must match the calling
 * Operator's Business — `markIncidentResolved` enforces the predicate in the
 * SQL `WHERE` clause, so an attacker guessing UUIDs gets a 404 rather than
 * mutating someone else's Incident. Same pattern as `disconnectSourceConnection`.
 *
 * The route does not require the Incident to be unresolved — re-marking a
 * resolved Incident just bumps `resolved_at`. The UI hides the button once
 * the Incident is resolved, so this only matters for racy double-clicks; we
 * lean on the SQL semantics rather than a status check + race window.
 *
 * Side effects:
 *   - `incidents.resolved_at` = now()
 *
 * The Escalations spawned by the original fire-incident run are NOT
 * touched — the audit trail of "we paged you about this on X" is independent
 * of the resolved state (see schema.ts incidents rationale).
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { markIncidentResolved } from "@/db/queries/incidents";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return new NextResponse(null, { status: 401 });

  const membership = await getOperatorWithBusinessByClerkUserId(userId);
  if (!membership) return new NextResponse(null, { status: 403 });

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return new NextResponse(null, { status: 400 });

  const row = await markIncidentResolved({
    id,
    businessId: membership.business.id,
  });
  if (!row) return new NextResponse(null, { status: 404 });

  return NextResponse.json({
    id: row.id,
    resolved_at: row.resolvedAt?.toISOString() ?? null,
  });
}
