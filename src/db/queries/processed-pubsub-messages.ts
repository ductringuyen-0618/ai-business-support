/**
 * Idempotency ledger for Google Pub/Sub push deliveries (slice 10).
 *
 * Pub/Sub re-delivers the same `messageId` whenever a push receiver responds
 * non-2xx (or no response inside the ack deadline). To stay idempotent at the
 * webhook layer we mark each message we've seen here BEFORE doing any work
 * (enqueueing ingest_review jobs, etc.). On a re-delivery the insert is a
 * no-op and the webhook 204s without re-enqueueing duplicates — pg-boss's
 * own idempotency on the downstream `ingest_review` job is the second line
 * of defence, not the first.
 *
 * Why `ON CONFLICT DO NOTHING` instead of an upsert: we never need to update
 * an existing row — the timestamp of the FIRST processing is the useful one.
 * The boolean "did this insert actually happen?" lets the caller branch
 * between "process now" and "skip; we've handled this".
 */
import { sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { processedPubsubMessages } from "@/db/schema";

/**
 * Record that we've seen a Pub/Sub messageId. Returns `true` if this is the
 * first time (caller should proceed to do the work), or `false` if the row
 * already existed (caller should 204 and skip — we already handled it).
 *
 * Safe under concurrent dispatches of the same message — the unique
 * constraint on `message_id` plus `ON CONFLICT DO NOTHING` means at most one
 * caller sees `true`.
 */
export async function recordProcessedPubsubMessage(messageId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .insert(processedPubsubMessages)
    .values({ messageId })
    .onConflictDoNothing({ target: processedPubsubMessages.messageId })
    .returning({ messageId: processedPubsubMessages.messageId });
  return rows.length > 0;
}

/**
 * Test-only helper to assert the ledger contains exactly the expected ids.
 * Lives here (not in tests/) so it can use the strongly-typed schema without
 * leaking Drizzle types into test files.
 */
export async function countProcessedPubsubMessages(): Promise<number> {
  const db = getDb();
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(processedPubsubMessages);
  return rows[0]?.count ?? 0;
}
