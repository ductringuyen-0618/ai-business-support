/**
 * Database schema.
 *
 * Slice 1 only introduces the two foundational tables (Businesses + Operators)
 * so that the migration story is proven end-to-end. Later slices extend this
 * file with source_connections, reviews, classifications, incidents,
 * escalations, digests, operator_channel_prefs (see PRD #1).
 *
 * Terminology follows CONTEXT.md verbatim: rows here represent Businesses and
 * Operators (NOT "tenants" / "users").
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Clerk Organization id — Business has one Clerk org (see ADR-0009).
  clerkOrgId: text("clerk_org_id").notNull().unique(),
  name: text("name").notNull(),
  // Optional industry vertical, used by the Playbook selector later.
  industry: text("industry"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Set when a Business cancels. Data is purged 30 days after this is set
  // (per ADR-0006). Null while active.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
});

export const operators = pgTable("operators", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Clerk User id — every Operator is a Clerk user.
  clerkUserId: text("clerk_user_id").notNull().unique(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Soft-delete marker set when Clerk fires `user.deleted`. We keep the row so
  // any Reviews/Incidents/Escalations historically attributed to this Operator
  // continue to render with a name in the UI; only the Business cancellation
  // flow (ADR-0006) triggers actual purges.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;
export type Operator = typeof operators.$inferSelect;
export type NewOperator = typeof operators.$inferInsert;
