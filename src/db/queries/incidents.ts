/**
 * Read + write helpers for the `incidents` table.
 *
 * Slice 11's `fire_incident` job is the only producer; slice 12's dashboard
 * will be a consumer. Keeping these helpers in one file gives the handler
 * unit tests a clean DI seam — they swap this module for a fake.
 */
import { eq } from "drizzle-orm";

import { getNodeDb } from "@/db/node-client";
import { incidents } from "@/db/schema";
import type { IncidentRow } from "@/db/schema";

export interface UpsertIncidentByReviewIdInput {
  reviewId: string;
  businessId: string;
  severity: string;
}

/**
 * Upsert an Incident keyed on `review_id`. Returns the (possibly pre-existing)
 * row so the caller can fan out Escalations against its id.
 *
 * Idempotency is enforced by the UNIQUE INDEX `incidents_review_id_unique`:
 * re-firing on the same Review hits the same row. We intentionally do NOT
 * overwrite `severity` on the re-fire path — the first fire's severity
 * defines the historical Incident, even if a re-classification under a new
 * prompt would call it differently (see schema.ts rationale).
 */
export async function upsertIncidentByReviewId(
  input: UpsertIncidentByReviewIdInput,
): Promise<IncidentRow> {
  const db = getNodeDb();
  const [row] = await db
    .insert(incidents)
    .values({
      reviewId: input.reviewId,
      businessId: input.businessId,
      severity: input.severity,
    })
    // On conflict do a no-op-ish update so RETURNING still emits a row.
    // We touch `business_id` to itself — Drizzle / Postgres treats this as a
    // valid no-op SET and keeps RETURNING happy.
    .onConflictDoUpdate({
      target: incidents.reviewId,
      set: { businessId: input.businessId },
    })
    .returning();
  if (!row) {
    throw new Error(
      `upsertIncidentByReviewId: expected at least one row from RETURNING for review_id=${input.reviewId}`,
    );
  }
  return row;
}

export async function findIncidentByReviewId(reviewId: string): Promise<IncidentRow | null> {
  const db = getNodeDb();
  const rows = await db.select().from(incidents).where(eq(incidents.reviewId, reviewId)).limit(1);
  return rows[0] ?? null;
}

export async function findIncidentById(id: string): Promise<IncidentRow | null> {
  const db = getNodeDb();
  const rows = await db.select().from(incidents).where(eq(incidents.id, id)).limit(1);
  return rows[0] ?? null;
}
