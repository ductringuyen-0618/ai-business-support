/**
 * Database schema.
 *
 * Slice 1 introduced the two foundational tables (Businesses + Operators).
 * Slice 6 adds `operator_channel_prefs` to back the EscalationRouter
 * (see `src/lib/escalation/`). Slice 8 adds `source_connections` to back the
 * Google OAuth flow. Slice 9 adds `reviews` + `classifications` to back the
 * `ingest_review` pipeline (ADR-0004). Later slices extend this file with
 * `incidents`, `escalations`, `digests` (see PRD #1).
 *
 * Terminology follows CONTEXT.md verbatim: rows here represent Businesses and
 * Operators (NOT "tenants" / "users").
 */
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
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
    // Slice 11: the SMS address. Only populated on the SMS row, only after a
    // successful phone-verification round-trip; null otherwise (including on
    // the Email row, where the address lives on `operators.email`).
    phoneE164: text("phone_e164"),
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
    // Slice 10: Google Business Profile `locationId` so the Pub/Sub webhook can
    // map a `{ accountId, locationId, notificationType }` push payload back to
    // a specific SourceConnection. Nullable because slice 8's OAuth callback
    // doesn't populate it yet — a follow-up wires the post-OAuth call that
    // lists the connected account's locations. Until then, Pub/Sub deliveries
    // for an unmatched location are dropped (Pub/Sub still acks via 204).
    googleLocationId: text("google_location_id"),
    // Slice 10: one-shot marker for the "your dashboard is ready" email
    // (ADR-0007). Set the first time the backfill handler crosses the ≥95%
    // threshold; re-runs see it set and skip the send.
    readyEmailSentAt: timestamp("ready_email_sent_at", { withTimezone: true }),
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

/**
 * One row per ingested Review (CONTEXT.md "Review"). The ingest pipeline
 * lives in `src/queue/handlers/ingest-review.ts` and per ADR-0004 makes
 * exactly one LLM call per row; the resulting `Classification` lives in the
 * companion table below.
 *
 * `review_text` is nullable for two reasons:
 *   1. Star-only Reviews (Google allows a 5-star with no body).
 *   2. Deletion Request (ADR-0006) nulls the raw body in place; the row stays
 *      so trend integrity is preserved.
 * `redacted_text` is ALWAYS populated (possibly empty string) — it is the
 * only text that ever leaves our boundary into Anthropic.
 *
 * Idempotency: `(source, source_review_id)` is unique so the same Review
 * arriving twice (live Pub/Sub + backfill page, or backfill retry) upserts
 * into the same row.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceConnectionId: uuid("source_connection_id")
      .notNull()
      .references(() => sourceConnections.id, { onDelete: "cascade" }),
    source: sourceEnum("source").notNull(),
    sourceReviewId: text("source_review_id").notNull(),
    starRating: integer("star_rating").notNull(),
    reviewText: text("review_text"),
    reviewerDisplayName: text("reviewer_display_name"),
    redactedText: text("redacted_text").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceReviewUnique: uniqueIndex("reviews_source_source_review_id_unique").on(
      table.source,
      table.sourceReviewId,
    ),
  }),
);

/**
 * One row per Classification (CONTEXT.md "Theme", ADR-0004). Keyed by
 * `review_id` so a Review has at most one Classification — re-classification
 * (prompt v2 rollout) overwrites in place rather than versioning rows.
 *
 * `classifications` is absent when ingestion persisted the Review but the
 * LLM call failed past pg-boss retries (see ingest-review handler). Slice 12
 * dashboards surface those rows as "unclassified".
 */
export const classifications = pgTable("classifications", {
  reviewId: uuid("review_id")
    .primaryKey()
    .references(() => reviews.id, { onDelete: "cascade" }),
  promptVersion: text("prompt_version").notNull(),
  isIncident: boolean("is_incident").notNull(),
  severity: text("severity"),
  themes: jsonb("themes").$type<string[]>().notNull(),
  sentiment: text("sentiment").notNull(),
  suggestedReply: text("suggested_reply").notNull(),
  classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Slice 10: idempotency ledger for Pub/Sub push messages.
 *
 * Google Pub/Sub assigns each delivered message a stable `messageId` and will
 * re-deliver the same id on any non-2xx response (or no response inside the
 * ack deadline). The webhook handler inserts the id here with
 * `ON CONFLICT DO NOTHING` before doing any work; a row already present means
 * "we processed this", so the handler 204s without re-enqueuing duplicates.
 */
export const processedPubsubMessages = pgTable("processed_pubsub_messages", {
  messageId: text("message_id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per Incident (CONTEXT.md "Incident"). Created by the `fire_incident`
 * job (slice 11) when a Classification has `is_incident=true`. We keep the
 * row separate from `classifications` because:
 *
 *   1. Re-classification under prompt v2 overwrites the Classification row in
 *      place, but the Incident — and the Escalations spawned from it — must
 *      survive that overwrite. The audit trail of "we paged you about this on
 *      X" is independent of "the LLM's current opinion of severity".
 *   2. The `incidents -> escalations` 1:N split is the natural place to hang
 *      future fields like `acknowledged_at` (slice 12+).
 *
 * Idempotency: `review_id` is UNIQUE — re-firing on the same Review (pg-boss
 * redelivery, slice-9 re-classification path, etc.) hits the same row.
 *
 * `severity` is denormalised from the Classification at fire-time so a future
 * re-classification with a different severity does not retroactively change
 * the historical Incident.
 */
export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    severity: text("severity").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    reviewUnique: uniqueIndex("incidents_review_id_unique").on(table.reviewId),
  }),
);

/**
 * Lifecycle of an Escalation row:
 *   - `queued` — written by `fire_incident`; `deliver_escalation` job
 *     scheduled with `startAfter = deliver_at`.
 *   - `sent` — the channel wrapper returned successfully.
 *   - `failed` — pg-boss exhausted its retries on a transient error, or the
 *     wrapper raised a non-retryable error. Final state; no further attempts.
 */
export const escalationStatusEnum = pgEnum("escalation_status", ["queued", "sent", "failed"]);

/**
 * One row per (Incident, Operator, Channel) Delivery (CONTEXT.md
 * "Escalation"). Materialises the `Delivery[]` produced by the
 * `EscalationRouter` so the pipeline can resume mid-flight after a worker
 * restart: `fire_incident` writes the rows and enqueues `deliver_escalation`
 * jobs; the consumer flips `status` and writes `delivered_at` on success.
 */
export const escalations = pgTable("escalations", {
  id: uuid("id").primaryKey().defaultRandom(),
  incidentId: uuid("incident_id")
    .notNull()
    .references(() => incidents.id, { onDelete: "cascade" }),
  operatorId: uuid("operator_id")
    .notNull()
    .references(() => operators.id, { onDelete: "cascade" }),
  channel: channelEnum("channel").notNull(),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  status: escalationStatusEnum("status").notNull().default("queued"),
});

/**
 * Pending phone-number verifications (slice 11). One row per Operator at a
 * time — re-starting verification overwrites the existing pending row so a
 * second "Verify" click invalidates the earlier code. Row is deleted on
 * successful confirm (the verified number then lives on
 * `operator_channel_prefs.phone_e164`).
 *
 * `code_hash` is a SHA-256 of the 6-digit code; we never store the code in
 * plaintext so a DB dump cannot be used to phone-hijack Operators mid-flight.
 */
export const phoneVerifications = pgTable("phone_verifications", {
  operatorId: uuid("operator_id")
    .primaryKey()
    .references(() => operators.id, { onDelete: "cascade" }),
  phoneE164: text("phone_e164").notNull(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;
export type Operator = typeof operators.$inferSelect;
export type NewOperator = typeof operators.$inferInsert;
export type OperatorChannelPrefRow = typeof operatorChannelPrefs.$inferSelect;
export type NewOperatorChannelPrefRow = typeof operatorChannelPrefs.$inferInsert;
export type SourceConnectionRow = typeof sourceConnections.$inferSelect;
export type NewSourceConnectionRow = typeof sourceConnections.$inferInsert;
export type ReviewRow = typeof reviews.$inferSelect;
export type NewReviewRow = typeof reviews.$inferInsert;
export type ClassificationRow = typeof classifications.$inferSelect;
export type NewClassificationRow = typeof classifications.$inferInsert;
export type ProcessedPubsubMessageRow = typeof processedPubsubMessages.$inferSelect;
export type NewProcessedPubsubMessageRow = typeof processedPubsubMessages.$inferInsert;
export type IncidentRow = typeof incidents.$inferSelect;
export type NewIncidentRow = typeof incidents.$inferInsert;
export type EscalationRow = typeof escalations.$inferSelect;
export type NewEscalationRow = typeof escalations.$inferInsert;
export type PhoneVerificationRow = typeof phoneVerifications.$inferSelect;
export type NewPhoneVerificationRow = typeof phoneVerifications.$inferInsert;
