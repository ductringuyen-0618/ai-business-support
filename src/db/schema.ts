/**
 * Database schema.
 *
 * Slice 1 introduced the two foundational tables (Businesses + Operators).
 * Slice 6 adds `operator_channel_prefs` to back the EscalationRouter
 * (see `src/lib/escalation/`). Slice 8 adds `source_connections` to back the
 * Google OAuth flow. Later slices extend this file with `reviews`,
 * `classifications`, `incidents`, `escalations`, `digests` (see PRD #1).
 *
 * Terminology follows CONTEXT.md verbatim: rows here represent Businesses and
 * Operators (NOT "tenants" / "users").
 */
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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

/**
 * Channels through which an Escalation can be delivered to an Operator.
 * MVP scope: Email (always available) and SMS (opt-in per Operator).
 * See CONTEXT.md "Channel" and ADR-0009.
 */
export const channelEnum = pgEnum("channel", ["email", "sms"]);

/**
 * Per-(Operator, Channel) preferences used by the EscalationRouter.
 *
 * - `enabled = false` means no Delivery is produced for that (Operator, Channel).
 * - `quiet_hours_start` / `quiet_hours_end` are local-time `time` values; they
 *   are interpreted in the row's `timezone` (IANA). Both null disables quiet
 *   hours for the pair. Windows may cross midnight (e.g. 23:00–07:00).
 * - `timezone` is an IANA zone name; defaults to UTC so a new Operator row is
 *   never silently in a wrong zone.
 */
export const operatorChannelPrefs = pgTable(
  "operator_channel_prefs",
  {
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    quietHoursStart: time("quiet_hours_start"),
    quietHoursEnd: time("quiet_hours_end"),
    timezone: text("timezone").notNull().default("UTC"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.operatorId, table.channel] }),
  }),
);

/**
 * External review platforms we ingest from (see CONTEXT.md "Source").
 * MVP only ships Google Business Profile. Yelp / Facebook adapters land later.
 */
export const sourceEnum = pgEnum("source", ["google"]);

/**
 * Operational status of a `source_connections` row.
 * - `pending` — row created but tokens not yet exchanged (transitional).
 * - `healthy` — tokens valid, last ingest succeeded.
 * - `errored` — tokens rejected by the Source, or repeated ingest failure;
 *   the dashboard shows a re-auth prompt.
 * - `disconnected` — Operator explicitly disconnected. Tokens are nulled but
 *   the row is kept so future re-connect can join old Reviews to it.
 */
export const sourceConnectionStatusEnum = pgEnum("source_connection_status", [
  "pending",
  "healthy",
  "errored",
  "disconnected",
]);

/**
 * Historical-backfill progress (see ADR-0007). Independent from `status` so a
 * still-healthy connection can be mid-backfill.
 */
export const sourceBackfillStatusEnum = pgEnum("source_backfill_status", [
  "pending",
  "running",
  "complete",
  "failed",
]);

/**
 * One row per (Business, Source) pairing. Materialises the in-memory
 * `SourceConnection` shape that `src/lib/sources/source-adapter.ts` consumes.
 *
 * Token columns hold AES-GCM ciphertext produced by
 * `src/lib/source-tokens/encrypt.ts` — never plaintext. App-level encryption
 * keeps key rotation to bumping `SOURCE_TOKEN_ENCRYPTION_KEY` (with a
 * versioned ciphertext prefix) rather than reloading a DB extension.
 *
 * Token columns are nullable because `disconnect` nulls them while keeping
 * the row; a fresh row written by the OAuth callback always has both populated.
 */
export const sourceConnections = pgTable(
  "source_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    source: sourceEnum("source").notNull(),
    oauthAccessToken: text("oauth_access_token"),
    oauthRefreshToken: text("oauth_refresh_token"),
    oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }),
    status: sourceConnectionStatusEnum("status").notNull().default("pending"),
    backfillStatus: sourceBackfillStatusEnum("backfill_status").notNull().default("pending"),
    loadedCount: integer("loaded_count").notNull().default(0),
    estimatedTotal: integer("estimated_total"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  },
  (table) => ({
    // One active connection per (Business, Source). Re-connect after disconnect
    // re-uses the same row via upsert — we don't create a second row.
    businessSourceUnique: unique("source_connections_business_id_source_unique").on(
      table.businessId,
      table.source,
    ),
  }),
);

export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;
export type Operator = typeof operators.$inferSelect;
export type NewOperator = typeof operators.$inferInsert;
export type OperatorChannelPrefRow = typeof operatorChannelPrefs.$inferSelect;
export type NewOperatorChannelPrefRow = typeof operatorChannelPrefs.$inferInsert;
export type SourceConnectionRow = typeof sourceConnections.$inferSelect;
export type NewSourceConnectionRow = typeof sourceConnections.$inferInsert;
