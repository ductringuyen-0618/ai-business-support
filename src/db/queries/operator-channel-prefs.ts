/**
 * Read + write helpers for `operator_channel_prefs`.
 *
 * Used by:
 *   - `fire_incident` (slice 11) — loads every pref for every Operator at a
 *     Business so the EscalationRouter sees the full prefs vector.
 *   - The settings UI (slice 11) — reads the calling Operator's prefs to
 *     render the toggles + quiet-hours pickers, and writes them back via
 *     `upsertChannelPref`.
 *   - The phone-verification confirm route (slice 11) — flips the SMS row
 *     to `enabled=true` with the verified number.
 *
 * Note: rows do not exist by default. The settings UI auto-creates the two
 * (email, sms) rows on first save; the `fire_incident` handler tolerates
 * their absence and falls back to "Email always-on" defaults (an Operator
 * who never opened the settings page still gets paged via email).
 */
import { and, eq, isNull } from "drizzle-orm";

import { getNodeDb } from "@/db/node-client";
import { operatorChannelPrefs, operators } from "@/db/schema";
import type { OperatorChannelPrefRow } from "@/db/schema";

export type Channel = "email" | "sms";

/**
 * Load every Operator at the Business along with all their channel prefs.
 * Single query rather than two so the `fire_incident` handler does one DB
 * round-trip for the fan-out shape.
 */
export interface OperatorWithPrefs {
  operatorId: string;
  prefs: OperatorChannelPrefRow[];
}

export async function findOperatorsWithPrefsByBusiness(
  businessId: string,
): Promise<OperatorWithPrefs[]> {
  const db = getNodeDb();

  // LEFT JOIN: an Operator with no prefs yet should still appear in the
  // result, so the caller can apply default-on Email behaviour. Filter
  // soft-deleted Operators here — they should not be paged.
  const rows = await db
    .select({
      operatorId: operators.id,
      pref: operatorChannelPrefs,
    })
    .from(operators)
    .leftJoin(operatorChannelPrefs, eq(operatorChannelPrefs.operatorId, operators.id))
    .where(and(eq(operators.businessId, businessId), isNull(operators.deletedAt)));

  const byOperator = new Map<string, OperatorChannelPrefRow[]>();
  for (const r of rows) {
    if (!byOperator.has(r.operatorId)) byOperator.set(r.operatorId, []);
    if (r.pref) byOperator.get(r.operatorId)!.push(r.pref);
  }

  const out: OperatorWithPrefs[] = [];
  for (const [id, prefs] of byOperator) {
    out.push({ operatorId: id, prefs });
  }
  return out;
}

export async function findChannelPrefsByOperator(
  operatorId: string,
): Promise<OperatorChannelPrefRow[]> {
  const db = getNodeDb();
  return db
    .select()
    .from(operatorChannelPrefs)
    .where(eq(operatorChannelPrefs.operatorId, operatorId));
}

export interface UpsertChannelPrefInput {
  operatorId: string;
  channel: Channel;
  enabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
  /** Only set when verified. The verification flow owns this column. */
  phoneE164?: string | null;
}

export async function upsertChannelPref(input: UpsertChannelPrefInput): Promise<void> {
  const db = getNodeDb();
  await db
    .insert(operatorChannelPrefs)
    .values({
      operatorId: input.operatorId,
      channel: input.channel,
      enabled: input.enabled,
      quietHoursStart: input.quietHoursStart,
      quietHoursEnd: input.quietHoursEnd,
      timezone: input.timezone,
      phoneE164: input.phoneE164 ?? null,
    })
    .onConflictDoUpdate({
      target: [operatorChannelPrefs.operatorId, operatorChannelPrefs.channel],
      set: {
        enabled: input.enabled,
        quietHoursStart: input.quietHoursStart,
        quietHoursEnd: input.quietHoursEnd,
        timezone: input.timezone,
        // Only overwrite phoneE164 if the input explicitly includes it.
        // The settings-page save shouldn't clobber a verified number just
        // because the form submitted didn't carry it.
        ...(input.phoneE164 !== undefined ? { phoneE164: input.phoneE164 } : {}),
      },
    });
}

/**
 * Enable SMS for an Operator + record the verified number. Called by the
 * phone-verification confirm route after the code matches. Treats the upsert
 * shape conservatively — if no SMS row exists, we create one with sensible
 * default quiet hours (none) and the verified number.
 */
export async function enableSmsWithVerifiedNumber(input: {
  operatorId: string;
  phoneE164: string;
}): Promise<void> {
  const db = getNodeDb();
  await db
    .insert(operatorChannelPrefs)
    .values({
      operatorId: input.operatorId,
      channel: "sms",
      enabled: true,
      timezone: "UTC",
      phoneE164: input.phoneE164,
    })
    .onConflictDoUpdate({
      target: [operatorChannelPrefs.operatorId, operatorChannelPrefs.channel],
      set: { enabled: true, phoneE164: input.phoneE164 },
    });
}
