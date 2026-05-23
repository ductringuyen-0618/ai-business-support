/**
 * `POST /api/sources/:id/retry-backfill`
 *
 * Operator-initiated retry of a failed backfill (slice 12, issue #14).
 *
 * Triggered by the dashboard's red "Retry backfill" banner when
 * `source_connections.backfill_status='failed'`. We flip the row back to
 * `pending` and enqueue a fresh `backfill_source` job — the slice-10 worker
 * resumes from the existing `loaded_count` (ingest is idempotent on
 * `(source, source_review_id)` so re-walking pages won't dupe Reviews).
 *
 * Authorisation: the SourceConnection's `business_id` must match the calling
 * Operator's Business. We re-load the row scoped to the Operator's Business
 * via `getSourceConnectionsForBusiness` — the auth check is "is there a
 * connection with this id in MY Business" rather than trusting the URL.
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import {
  getSourceConnectionsForBusiness,
  updateBackfillProgress,
} from "@/db/queries/source-connections";
import { enqueueBackfillSource } from "@/queue/boss";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return new NextResponse(null, { status: 401 });

  const membership = await getOperatorWithBusinessByClerkUserId(userId);
  if (!membership) return new NextResponse(null, { status: 403 });

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return new NextResponse(null, { status: 400 });

  // Tenant scope: load the Business's connections and confirm `id` is in the
  // set. Cheaper than a second query because the dashboard already pulled
  // these recently, and the round-trip is small.
  const connections = await getSourceConnectionsForBusiness(membership.business.id);
  const match = connections.find((c) => c.id === id);
  if (!match) return new NextResponse(null, { status: 404 });

  // Reset backfill state so the consumer treats this as a fresh run. We do
  // NOT reset loaded_count — slice 10's ingest is idempotent so re-walking
  // pages won't dupe Reviews, and the operator wants to see "we're still
  // making progress" rather than the counter resetting to zero.
  await updateBackfillProgress({
    id,
    backfillStatus: "pending",
  });

  await enqueueBackfillSource({ source_connection_id: id });

  return NextResponse.json({ ok: true });
}
