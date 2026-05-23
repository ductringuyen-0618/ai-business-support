import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

/**
 * Slice 1 dashboard shell — the empty room every other slice will furnish.
 *
 * The middleware guarantees `currentUser()` returns a signed-in Operator here;
 * we belt-and-brace with an explicit redirect in case the middleware matcher
 * ever drifts.
 *
 * The greeting uses the Clerk user's first name when available, falling back
 * to the primary email address — both are sourced from the Clerk session and
 * map onto the Operator concept (per ADR-0009).
 */
export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) {
    redirect("/sign-in");
  }

  const operatorName =
    user.firstName ?? user.username ?? user.primaryEmailAddress?.emailAddress ?? "Operator";

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Hello, {operatorName}</h1>
        <p className="text-sm text-slate-600">
          This is the dashboard shell for Slice 1. Later slices add the Review list, Theme charts,
          Incident triage, and backfill banner.
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
