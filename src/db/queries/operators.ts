/**
 * Read helpers for Operator + Business rows.
 *
 * Kept as a thin module so server components, route handlers, and tests can all
 * share the same query shape and we have one obvious place to wire row-level
 * authorisation in later slices (per ADR-0009 — Clerk owns identity, but the
 * app enforces `WHERE business_id = current_operator.business_id`).
 */
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db/client";
import { businesses, operators } from "@/db/schema";
import type { Business, Operator } from "@/db/schema";

export interface OperatorWithBusiness {
  operator: Operator;
  business: Business;
}

/**
 * Resolve the Operator row + their Business for the given Clerk user id.
 *
 * Returns `null` if no Operator row exists yet (e.g. the Clerk webhook has not
 * fired yet, or the Operator has been soft-deleted). The dashboard treats this
 * as "membership pending" and renders a friendlier waiting state.
 */
export async function getOperatorWithBusinessByClerkUserId(
  clerkUserId: string,
): Promise<OperatorWithBusiness | null> {
  const db = getDb();
  const rows = await db
    .select({ operator: operators, business: businesses })
    .from(operators)
    .innerJoin(businesses, eq(operators.businessId, businesses.id))
    .where(eq(operators.clerkUserId, clerkUserId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  // A soft-deleted Operator is treated as "no membership" for routing purposes.
  if (row.operator.deletedAt !== null) return null;
  return row;
}

/**
 * List active (not soft-deleted) Operators for a Business. Used by slice 10's
 * backfill handler to fan out the "your dashboard is ready" email to every
 * Operator the Business has on file.
 */
export async function listActiveOperatorsForBusiness(businessId: string): Promise<Operator[]> {
  const db = getDb();
  return db
    .select()
    .from(operators)
    .where(and(eq(operators.businessId, businessId), isNull(operators.deletedAt)));
}
