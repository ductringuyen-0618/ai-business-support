/**
 * Read + write helpers for the `escalations` table.
 *
 * The two writers are `fire_incident` (inserts `queued` rows) and
 * `deliver_escalation` (marks them `sent` / `failed`). Reads are used by the
 * `deliver_escalation` handler to assemble the email/SMS payload and by
 * slice 12's dashboard.
 */
import { and, eq } from "drizzle-orm";

import { getNodeDb } from "@/db/node-client";
import {
  businesses,
  classifications,
  escalations,
  incidents,
  operators,
  operatorChannelPrefs,
  reviews,
} from "@/db/schema";
import type {
  Business,
  ClassificationRow,
  EscalationRow,
  IncidentRow,
  Operator,
  OperatorChannelPrefRow,
  ReviewRow,
} from "@/db/schema";

export interface NewEscalationInput {
  incidentId: string;
  operatorId: string;
  channel: "email" | "sms";
}

/**
 * Insert an `escalations` row. We do NOT dedupe at the DB layer because the
 * deduping shape (one Escalation per (Incident, Operator, Channel)) is
 * enforced by the `fire_incident` handler — if the Incident already exists
 * we DON'T re-fan-out, so we never reach this insert twice for the same
 * tuple in normal flow. (The router is pure: same inputs → same Deliveries,
 * so re-running on an existing Incident would just re-derive the same
 * tuples.)
 */
export async function insertEscalation(input: NewEscalationInput): Promise<EscalationRow> {
  const db = getNodeDb();
  const [row] = await db
    .insert(escalations)
    .values({
      incidentId: input.incidentId,
      operatorId: input.operatorId,
      channel: input.channel,
    })
    .returning();
  if (!row) {
    throw new Error("insertEscalation: expected at least one row from RETURNING");
  }
  return row;
}

export async function countEscalationsForIncident(incidentId: string): Promise<number> {
  const db = getNodeDb();
  const rows = await db
    .select({ id: escalations.id })
    .from(escalations)
    .where(eq(escalations.incidentId, incidentId));
  return rows.length;
}

export async function markEscalationSent(id: string): Promise<void> {
  const db = getNodeDb();
  await db
    .update(escalations)
    .set({ status: "sent", deliveredAt: new Date() })
    .where(eq(escalations.id, id));
}

export async function markEscalationFailed(id: string): Promise<void> {
  const db = getNodeDb();
  await db.update(escalations).set({ status: "failed" }).where(eq(escalations.id, id));
}

/**
 * The full Delivery context the `deliver_escalation` handler needs to render
 * an Email body or an SMS body — joining `escalations` through to its
 * Operator, Incident, Review, Classification, and Business. Returned as
 * a flat object because the handler doesn't care about repeating tables.
 */
export interface EscalationContext {
  escalation: EscalationRow;
  operator: Operator;
  operatorPref: OperatorChannelPrefRow | null;
  incident: IncidentRow;
  review: ReviewRow;
  classification: ClassificationRow | null;
  business: Business;
}

export async function findEscalationContext(id: string): Promise<EscalationContext | null> {
  const db = getNodeDb();
  const rows = await db
    .select({
      escalation: escalations,
      operator: operators,
      incident: incidents,
      review: reviews,
      business: businesses,
    })
    .from(escalations)
    .innerJoin(operators, eq(escalations.operatorId, operators.id))
    .innerJoin(incidents, eq(escalations.incidentId, incidents.id))
    .innerJoin(reviews, eq(incidents.reviewId, reviews.id))
    .innerJoin(businesses, eq(incidents.businessId, businesses.id))
    .where(eq(escalations.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // The Classification is a separate look-up because slice 9 allows a Review
  // to lack one (LLM failure path). We still expect it to exist when an
  // Incident has fired, but we tolerate its absence rather than crash.
  const classificationRows = await db
    .select()
    .from(classifications)
    .where(eq(classifications.reviewId, row.review.id))
    .limit(1);

  // Same for the (Operator, Channel) pref — present in every default flow
  // (the prefs UI creates rows) but tolerated as null for older Operators
  // who haven't visited the settings page yet.
  const prefRows = await db
    .select()
    .from(operatorChannelPrefs)
    .where(
      and(
        eq(operatorChannelPrefs.operatorId, row.operator.id),
        eq(operatorChannelPrefs.channel, row.escalation.channel),
      ),
    )
    .limit(1);

  return {
    escalation: row.escalation,
    operator: row.operator,
    operatorPref: prefRows[0] ?? null,
    incident: row.incident,
    review: row.review,
    classification: classificationRows[0] ?? null,
    business: row.business,
  };
}
