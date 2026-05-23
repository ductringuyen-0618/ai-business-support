/**
 * Read + write helpers for the `digests` table (slice 14).
 *
 * The cron `compose_digest` handler writes one row per (Business, week) right
 * before sending the email. We don't need a "find latest digest for Business"
 * helper yet — the dashboard's Trends tab (slice 13+) will surface them but
 * via its own query shape. Keep this module minimal until consumers land.
 */
import { getNodeDb } from "@/db/node-client";
import { digests, type DigestBody, type DigestRow } from "@/db/schema";

export interface InsertDigestInput {
  businessId: string;
  periodStart: Date;
  periodEnd: Date;
  body: DigestBody;
}

export async function insertDigest(input: InsertDigestInput): Promise<DigestRow> {
  const db = getNodeDb();
  const [row] = await db
    .insert(digests)
    .values({
      businessId: input.businessId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      body: input.body,
    })
    .returning();
  if (!row) {
    throw new Error("insertDigest: expected INSERT to return one row");
  }
  return row;
}
