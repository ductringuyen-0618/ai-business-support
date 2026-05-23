import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { countUnclassifiedReviewsForBusiness, listReviewsForBusiness } from "@/db/queries/reviews";
import { getSourceConnectionsForBusiness } from "@/db/queries/source-connections";
import { getStarRatingTrend, getThemeFrequency } from "@/db/queries/trends";

import { ConnectGoogleButton, DashboardFlash, DisconnectGoogleButton } from "./connections";
import { BackfillBanner } from "./_components/backfill-banner";
import { FilterBar } from "./_components/filter-bar";
import { PAGE_SIZE, parseDashboardFilters, resolveDateRange } from "./_components/filters";
import { Pagination } from "./_components/pagination";
import { ReviewRow } from "./_components/review-row";
import { legendThemes, shapeStarTrend, shapeThemeFrequency } from "./_components/shape-trends";
import { TrendsSection } from "./_components/trends-section";
import { UnclassifiedBanner } from "./_components/unclassified-banner";

/**
 * Operator dashboard (slice 12, issue #14).
 *
 * Server component. Reads filters from `searchParams`, runs the query helpers
 * once, and composes the page. The filter bar / pagination / drawer mutate
 * the URL via `next/navigation` and the server re-renders on the new query.
 *
 * Layout:
 *   1. Header with operator + business name.
 *   2. Flash banner from `?flash=` (Google OAuth success/failure carry-over).
 *   3. Backfill banner (only when connected + backfill_status != complete).
 *   4. Unclassified-Reviews banner (only when count > 0).
 *   5. Google Source connect/disconnect row.
 *   6. Filter bar.
 *   7. Review list + pagination.
 *
 * Data flow per render:
 *   - operator + business resolution (1 query).
 *   - source connections (1 query, already shown by slice 8).
 *   - listReviewsForBusiness with parsed filters (2 queries — page + count).
 *   - countUnclassifiedReviewsForBusiness (1 query).
 *   - countUnresolvedIncidentsForBusiness is also read here so the layout's
 *     nav badge stays consistent with the page; the layout re-reads it but
 *     having a server-component-local snapshot avoids a flash on slow nav.
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
  const filters = parseDashboardFilters(params);
  const range = resolveDateRange(filters);

  const sourceConnections = await getSourceConnectionsForBusiness(business.id);
  const googleConnection =
    sourceConnections.find((c) => c.source === "google" && c.status !== "disconnected") ?? null;

  // Trend queries deliberately do NOT include the Theme filter — the bar
  // chart is itself the Theme breakdown, and narrowing to one Theme would
  // defeat the visualization. The list still respects the Theme filter.
  const trendFilters = {
    ratings: filters.ratings,
    since: range?.since,
    until: range?.until,
    incidentsOnly: filters.incidentsOnly,
  };

  const [reviewList, unclassifiedCount, starTrendRows, themeFreqRows] = await Promise.all([
    listReviewsForBusiness({
      businessId: business.id,
      filters: {
        themes: filters.themes,
        ratings: filters.ratings,
        since: range?.since,
        until: range?.until,
        incidentsOnly: filters.incidentsOnly,
      },
      page: filters.page,
      perPage: PAGE_SIZE,
    }),
    countUnclassifiedReviewsForBusiness(business.id),
    getStarRatingTrend({ businessId: business.id, filters: trendFilters }),
    getThemeFrequency({ businessId: business.id, filters: trendFilters }),
  ]);

  const starTrend = shapeStarTrend(starTrendRows);
  const themeFrequency = shapeThemeFrequency(themeFreqRows);
  const themeLegend = legendThemes(themeFrequency);

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Hello, {operatorName}</h1>
        <p className="text-sm text-slate-600">
          Signed in to <span className="font-medium text-slate-900">{business.name}</span>.
        </p>
      </header>

      <DashboardFlash flash={flash} />

      {googleConnection ? (
        <BackfillBanner
          connectionId={googleConnection.id}
          status={googleConnection.status}
          backfillStatus={googleConnection.backfillStatus}
          loadedCount={googleConnection.loadedCount}
          estimatedTotal={googleConnection.estimatedTotal}
        />
      ) : null}

      <UnclassifiedBanner count={unclassifiedCount} />

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

      <FilterBar filters={filters} />

      <TrendsSection
        starTrend={starTrend}
        themeFrequency={themeFrequency}
        themeLegend={themeLegend}
        filters={filters}
      />

      <section aria-label="Reviews" className="space-y-3">
        {reviewList.rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            {reviewList.total === 0 &&
            filters.themes.length + filters.ratings.length === 0 &&
            !filters.incidentsOnly &&
            filters.preset === null
              ? "No Reviews yet — once your backfill finishes they’ll show up here."
              : "No Reviews match the current filters."}
          </div>
        ) : (
          reviewList.rows.map((row) => (
            <ReviewRow
              key={row.review.id}
              review={row.review}
              classification={row.classification}
              incident={row.incident}
            />
          ))
        )}
      </section>

      <Pagination page={filters.page} total={reviewList.total} perPage={PAGE_SIZE} />
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

// Force-dynamic so Clerk's `currentUser()` cookie read isn't treated as a
// static-render error during `next build`.
export const dynamic = "force-dynamic";
