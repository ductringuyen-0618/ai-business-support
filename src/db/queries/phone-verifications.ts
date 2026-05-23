/**
 * Read + write helpers for the `phone_verifications` table.
 *
 * Workflow (slice 11):
 *   1. `POST /api/operator/verify-phone/start` calls `upsertPendingVerification`
 *      with the SHA-256 of a freshly minted 6-digit code; the row's primary
 *      key (operator_id) ensures a second "Verify" click overwrites the
 *      previous pending code.
 *   2. Twilio is asked to SMS the plaintext code.
 *   3. `POST /api/operator/verify-phone/confirm` calls `findPendingVerification`,
 *      compares hashes in constant time, then calls `deletePendingVerification`
 *      and flips the SMS pref.
 *
 * The plaintext code never touches the DB. The hash is salted by Postgres's
 * `gen_random_uuid()`-like uniqueness assumption only insofar as different
 * Operators have different rows — for a single Operator, two simultaneous
 * "start verify" calls would both write the same row, last-writer-wins.
 */
import { eq } from "drizzle-orm";

import { getNodeDb } from "@/db/node-client";
import { phoneVerifications } from "@/db/schema";
import type { PhoneVerificationRow } from "@/db/schema";

export interface UpsertPendingVerificationInput {
  operatorId: string;
  phoneE164: string;
  codeHash: string;
  expiresAt: Date;
}

export async function upsertPendingVerification(
  input: UpsertPendingVerificationInput,
): Promise<void> {
  const db = getNodeDb();
  await db
    .insert(phoneVerifications)
    .values({
      operatorId: input.operatorId,
      phoneE164: input.phoneE164,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
    })
    .onConflictDoUpdate({
      target: phoneVerifications.operatorId,
      set: {
        phoneE164: input.phoneE164,
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
        createdAt: new Date(),
      },
    });
}

export async function findPendingVerification(
  operatorId: string,
): Promise<PhoneVerificationRow | null> {
  const db = getNodeDb();
  const rows = await db
    .select()
    .from(phoneVerifications)
    .where(eq(phoneVerifications.operatorId, operatorId))
    .limit(1);
  return rows[0] ?? null;
}

export async function deletePendingVerification(operatorId: string): Promise<void> {
  const db = getNodeDb();
  await db.delete(phoneVerifications).where(eq(phoneVerifications.operatorId, operatorId));
}
