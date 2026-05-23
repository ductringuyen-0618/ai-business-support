/**
 * `POST /api/operator/channel-prefs`
 *
 * Save the current Operator's `operator_channel_prefs` rows from the settings
 * UI (slice 11). Authorisation: the Clerk session must resolve to an Operator
 * in our local DB; we write rows scoped to that Operator's id and no other.
 *
 * Body shape:
 *
 *   {
 *     "email": { "enabled": true, "quietHoursStart": "22:00", "quietHoursEnd": "07:00", "timezone": "America/Los_Angeles" },
 *     "sms":   { "enabled": false, "quietHoursStart": null,    "quietHoursEnd": null,    "timezone": "UTC" }
 *   }
 *
 * The SMS row's `phoneE164` is NOT writable here — it only mutates through the
 * `verify-phone/confirm` route after a successful code round-trip.
 *
 * ADR-0009 nuance: Email can be disabled (the ADR says "default on, always
 * available" — not "force on"). The UI surfaces a warning when Email is off
 * but the API accepts it.
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { upsertChannelPref } from "@/db/queries/operator-channel-prefs";

export const runtime = "nodejs";

// "HH:mm" or "HH:mm:ss" — match `time` columns in Postgres.
const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/);

const channelBlock = z.object({
  enabled: z.boolean(),
  quietHoursStart: timeString.nullable(),
  quietHoursEnd: timeString.nullable(),
  timezone: z.string().min(1),
});

const bodySchema = z.object({
  email: channelBlock,
  sms: channelBlock,
});

export type ChannelPrefsBody = z.infer<typeof bodySchema>;

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new NextResponse(null, { status: 401 });

  const membership = await getOperatorWithBusinessByClerkUserId(userId);
  if (!membership) return new NextResponse(null, { status: 403 });

  let parsed: ChannelPrefsBody;
  try {
    const json = await request.json();
    parsed = bodySchema.parse(json);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // Reject IANA strings we can't recognise — `Intl.DateTimeFormat` throws on
  // invalid zones, so we use it as the validation oracle. `supportedValuesOf`
  // omits things like "UTC" / "Etc/*" depending on the ICU build, so it's
  // not safe as the sole gate. Belt-and-braces against a hand-crafted POST.
  if (!isValidTimezone(parsed.email.timezone) || !isValidTimezone(parsed.sms.timezone)) {
    return NextResponse.json({ error: "unknown IANA timezone" }, { status: 400 });
  }

  await upsertChannelPref({
    operatorId: membership.operator.id,
    channel: "email",
    enabled: parsed.email.enabled,
    quietHoursStart: parsed.email.quietHoursStart,
    quietHoursEnd: parsed.email.quietHoursEnd,
    timezone: parsed.email.timezone,
  });
  await upsertChannelPref({
    operatorId: membership.operator.id,
    channel: "sms",
    enabled: parsed.sms.enabled,
    quietHoursStart: parsed.sms.quietHoursStart,
    quietHoursEnd: parsed.sms.quietHoursEnd,
    timezone: parsed.sms.timezone,
  });

  return NextResponse.json({ ok: true });
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
