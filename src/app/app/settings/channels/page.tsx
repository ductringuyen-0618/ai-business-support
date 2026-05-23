import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { findChannelPrefsByOperator } from "@/db/queries/operator-channel-prefs";

import { ChannelPrefsForm } from "./channel-prefs-form";

/**
 * Operator settings — channel preferences page (slice 11).
 *
 * Server component: resolves the calling Operator, loads their current
 * `operator_channel_prefs` rows (synthesising defaults if none exist), and
 * renders the client-side form. Posts to `/api/operator/channel-prefs` and
 * the `/api/operator/verify-phone/*` round-trip via the client component.
 */
export default async function ChannelSettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const membership = await getOperatorWithBusinessByClerkUserId(user.id);
  if (!membership) redirect("/app/dashboard");

  const prefs = await findChannelPrefsByOperator(membership.operator.id);
  const emailPref = prefs.find((p) => p.channel === "email") ?? null;
  const smsPref = prefs.find((p) => p.channel === "sms") ?? null;

  // Default fall-backs match the EscalationRouter's expectations: Email
  // always-on, SMS opt-in (so default `enabled=false`).
  const initial = {
    email: {
      enabled: emailPref?.enabled ?? true,
      quietHoursStart: emailPref?.quietHoursStart ?? null,
      quietHoursEnd: emailPref?.quietHoursEnd ?? null,
      timezone: emailPref?.timezone ?? defaultTimezone(),
    },
    sms: {
      enabled: smsPref?.enabled ?? false,
      quietHoursStart: smsPref?.quietHoursStart ?? null,
      quietHoursEnd: smsPref?.quietHoursEnd ?? null,
      timezone: smsPref?.timezone ?? defaultTimezone(),
      phoneE164: smsPref?.phoneE164 ?? null,
    },
  };

  // Populate the timezone dropdown from runtime IANA list — keeps us
  // future-proof when ICU updates ship a new region.
  const timezones = Intl.supportedValuesOf("timeZone");

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Channel preferences</h1>
        <p className="text-sm text-slate-600">
          Choose how we page you when an Incident fires. Email is on by default and always
          available. SMS is opt-in and requires phone verification.
        </p>
        <p className="text-xs text-slate-500">
          You can turn Email off, but you&apos;ll only receive Incidents through any other enabled
          Channels — make sure at least one Channel is enabled to avoid missing pages.
        </p>
      </header>

      <ChannelPrefsForm initial={initial} timezones={timezones} />
    </section>
  );
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}
