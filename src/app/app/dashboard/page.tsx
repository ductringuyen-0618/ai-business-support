import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";

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
 */
export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) {
    redirect("/sign-in");
  }

  const operatorName =
    user.firstName ?? user.username ?? user.primaryEmailAddress?.emailAddress ?? "Operator";

  const membership = await getOperatorWithBusinessByClerkUserId(user.id);

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

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Hello, {operatorName}</h1>
        <p className="text-sm text-slate-600">
          Signed in to <span className="font-medium text-slate-900">{business.name}</span>.
        </p>
      </header>

      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
        <p className="font-medium text-slate-900">Empty room.</p>
        <p className="mt-1">
          No Sources are connected yet. Once Slice 4 lands, you will be able to connect Google
          Business Profile from here and your Reviews will start flowing in.
        </p>
      </div>
    </section>
  );
}
