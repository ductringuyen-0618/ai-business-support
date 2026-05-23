import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { getSourceConnectionsForBusiness } from "@/db/queries/source-connections";

import { ConnectGoogleButton, DashboardFlash, DisconnectGoogleButton } from "./connections";

/**
 * Dashboard shell.
 *
 * Resolves the Operator + Business from the DB (seeded by the Clerk webhook)
 * rather than only the Clerk session. Per ADR-0009 the Clerk session is
 * sufficient for identity, but every business-level decision in this app keys
 * off our local `business_id`, so we read it here once and route on it.
 *
 * If the local row hasn't appeared yet (webhook still in flight, or Clerk
 * delivery failing), we render a "membership pending" state instead of
 * crashing — the webhook will catch up on retry.
 *
 * Slice 8: render the Google Source connection state — "Connect Google" CTA
 * when no `source_connections` row exists, a status pill + Disconnect button
 * when one does. The OAuth callback redirects here with `?flash=...` for
 * one-shot success / failure banners.
 */
export default async function DashboardPage({
  searchParams,
}: {
  // Next 15 passes searchParams as a Promise in server components.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect("/sign-in");
  }

  const operatorName =
    user.firstName ?? user.username ?? user.primaryEmailAddress?.emailAddress ?? "Operator";

  const membership = await getOperatorWithBusinessByClerkUserId(user.id);
  const params = await searchParams;
  const flashRaw = params.flash;
  const flash = typeof flashRaw === "string" ? flashRaw : null;

  if (!membership) {
    return (
      <section className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Hello, {operatorName}</h1>
          <p className="text-sm text-slate-600">
            We&apos;re still setting up your workspace. This usually takes a few seconds — refresh
            in a moment.
          </p>
        </header>

        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
          <p className="font-medium text-slate-900">Membership pending.</p>
          <p className="mt-1">
            Your Clerk account is signed in but we haven&apos;t received the matching webhook from
            Clerk yet. If this persists for more than a minute, contact support.
          </p>
        </div>
      </section>
    );
  }

  const { business } = membership;
  const sourceConnections = await getSourceConnectionsForBusiness(business.id);
  // We treat `disconnected` rows as "not connected" for the dashboard CTA — a
  // disconnected row is just an empty slot waiting for re-auth, not a live
  // connection to manage.
  const googleConnection =
    sourceConnections.find((c) => c.source === "google" && c.status !== "disconnected") ?? null;

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Hello, {operatorName}</h1>
        <p className="text-sm text-slate-600">
          Signed in to <span className="font-medium text-slate-900">{business.name}</span>.
        </p>
      </header>

      <DashboardFlash flash={flash} />

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-slate-900">Google Business Profile</p>
            <p className="mt-1 text-slate-600">
              {googleConnection
                ? `Connected. Backfill ${googleConnection.backfillStatus}.`
                : "Not connected. Connect to start pulling your Google reviews."}
            </p>
          </div>
          {googleConnection ? (
            <div className="flex items-center gap-3">
              <StatusPill status={googleConnection.status} />
              <DisconnectGoogleButton connectionId={googleConnection.id} />
            </div>
          ) : (
            <ConnectGoogleButton />
          )}
        </div>
      </div>
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "healthy"
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : status === "errored"
        ? "bg-red-100 text-red-800 border-red-200"
        : "bg-slate-100 text-slate-700 border-slate-200";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      Connected · {status}
    </span>
  );
}
