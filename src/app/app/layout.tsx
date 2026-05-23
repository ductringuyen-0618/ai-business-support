import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";

import { countUnresolvedIncidentsForBusiness } from "@/db/queries/incidents";
import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";

/**
 * Authenticated app shell. Anything under /app/* lives inside this layout
 * and is gated by Clerk middleware in `src/middleware.ts`.
 *
 * Slice 12 adds the unresolved-Incidents count badge next to the Dashboard
 * nav link. We resolve the Operator's Business via Clerk + the operator
 * lookup (same pattern the dashboard server component uses) and read the
 * count in one round-trip. If the operator hasn't been provisioned yet
 * (Clerk webhook still landing), we render the nav without the badge.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser().catch(() => null);
  let unresolvedIncidents = 0;
  if (user) {
    const membership = await getOperatorWithBusinessByClerkUserId(user.id);
    if (membership) {
      unresolvedIncidents = await countUnresolvedIncidentsForBusiness(membership.business.id);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <Link href="/app/dashboard" className="text-sm font-semibold tracking-tight">
              ai-business-support
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-600">
              <Link
                href="/app/dashboard"
                className="inline-flex items-center gap-2 hover:text-slate-900"
              >
                Dashboard
                {unresolvedIncidents > 0 ? (
                  <span
                    aria-label={`${unresolvedIncidents} unresolved Incidents`}
                    className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white"
                  >
                    {unresolvedIncidents}
                  </span>
                ) : null}
              </Link>
              <Link href="/app/settings/channels" className="hover:text-slate-900">
                Channels
              </Link>
            </nav>
          </div>
          <UserButton afterSignOutUrl="/" />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
