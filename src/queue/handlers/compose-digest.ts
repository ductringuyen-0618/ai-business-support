/**
 * `compose_digest` job handler (slice 14, issue #16).
 *
 * Algorithm:
 *
 *   1. Load the Business. If missing or cancelled, bail.
 *   2. Resolve the Business's reference timezone (operators[0].timezone via
 *      operator_channel_prefs, falling back to UTC).
 *   3. Compute the period: previous 7 days ending at the most recent
 *      Monday-08:00 local. Period bounds are UTC instants.
 *   4. Load classified Reviews in the current period AND the prior 7-day
 *      window (for week-over-week Theme deltas).
 *   5. If current-period Reviews < 1, skip — no Digest row, no email. (ADR-0008
 *      "A Business with 0 Reviews in the week skips the Digest entirely".)
 *   6. Compute `weekOverWeekTheme` aggregates.
 *   7. Call `composeDigest()` (one LLM call).
 *   8. Persist the `digests` row.
 *   9. Load all active Operator emails for the Business.
 *  10. Render the email and send via `sendEmail()`.
 *
 * Scheduling — Monday 08:00 per timezone:
 *   pg-boss v10 schedules cron strings in UTC, which makes per-Business local
 *   schedules awkward. Instead we run a single hourly enqueuer
 *   (`compose_digest_enqueuer`, cron `0 * * * *`) that:
 *     - Lists all active Businesses;
 *     - For each, computes the current local hour in that Business's reference
 *       timezone;
 *     - Emits a `compose_digest` job iff "now" === "Monday 08:00 local".
 *   `singletonKey: <business_id>-<isoYearWeek>` deduplicates a re-run inside
 *   the same hour (worker restart, manual trigger).
 *
 * Idempotency: re-running for the same `singletonKey` is a no-op at pg-boss
 * level. If the singleton constraint is bypassed (e.g. a different code path
 * enqueues), this handler will write a second `digests` row and send a second
 * email — we accept that as the cost of keeping the handler stateless and
 * simple. The singleton key is the contract.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { Job } from "pg-boss";

import {
  type ClassifiedReviewRow,
  findActiveBusinessById as findActiveBusinessByIdDefault,
  findActiveOperatorEmailsForBusiness as findActiveOperatorEmailsForBusinessDefault,
  findBusinessReferenceTimezone as findBusinessReferenceTimezoneDefault,
  findClassifiedReviewsForBusinessInPeriod as findClassifiedReviewsForBusinessInPeriodDefault,
  listActiveBusinesses as listActiveBusinessesDefault,
} from "@/db/queries/digest-window";
import { insertDigest as insertDigestDefault } from "@/db/queries/digests";
import type { Business } from "@/db/schema";
import {
  composeDigest as composeDigestDefault,
  type ClassifiedReview,
  type DigestBody,
} from "@/lib/digest/composer";
import { PLAYBOOK, type Theme } from "@/lib/digest/playbook";
import { renderDigestEmail } from "@/lib/email/digest-email";
import { sendEmail as sendEmailDefault } from "@/lib/email/resend";

import {
  type ComposeDigestPayload,
  enqueueComposeDigest as enqueueComposeDigestDefault,
} from "../boss";

export { COMPOSE_DIGEST_JOB, type ComposeDigestPayload } from "../boss";

/**
 * Dependency-injection seam. Production code uses the defaults pointing at
 * Drizzle + the real Anthropic / Resend clients; tests pass fakes.
 */
export interface ComposeDigestDeps {
  findActiveBusinessById: typeof findActiveBusinessByIdDefault;
  findBusinessReferenceTimezone: typeof findBusinessReferenceTimezoneDefault;
  findClassifiedReviewsForBusinessInPeriod: typeof findClassifiedReviewsForBusinessInPeriodDefault;
  findActiveOperatorEmailsForBusiness: typeof findActiveOperatorEmailsForBusinessDefault;
  insertDigest: typeof insertDigestDefault;
  composeDigest: typeof composeDigestDefault;
  sendEmail: typeof sendEmailDefault;
  /** Pinnable in tests for deterministic period math. */
  now: () => Date;
  /** Override the dashboard base URL surfaced in the email CTA. */
  appBaseUrl?: string;
}

export const DEFAULT_COMPOSE_DIGEST_DEPS: ComposeDigestDeps = {
  findActiveBusinessById: findActiveBusinessByIdDefault,
  findBusinessReferenceTimezone: findBusinessReferenceTimezoneDefault,
  findClassifiedReviewsForBusinessInPeriod: findClassifiedReviewsForBusinessInPeriodDefault,
  findActiveOperatorEmailsForBusiness: findActiveOperatorEmailsForBusinessDefault,
  insertDigest: insertDigestDefault,
  composeDigest: composeDigestDefault,
  sendEmail: sendEmailDefault,
  now: () => new Date(),
};

export async function handleComposeDigest(
  jobs: Job<ComposeDigestPayload>[],
  deps: ComposeDigestDeps = DEFAULT_COMPOSE_DIGEST_DEPS,
): Promise<void> {
  for (const job of jobs) {
    await processOne(job, deps);
  }
}

async function processOne(job: Job<ComposeDigestPayload>, deps: ComposeDigestDeps): Promise<void> {
  const { business_id: businessId } = job.data;

  // 1. Business present + active.
  const business = await deps.findActiveBusinessById(businessId);
  if (!business) {
    console.warn(`[compose_digest] business ${businessId} not found / cancelled; skipping`);
    return;
  }

  // 2 + 3. Resolve timezone + compute window.
  const timezone = await deps.findBusinessReferenceTimezone(businessId);
  const { periodStart, periodEnd, previousStart } = computeDigestWindow(deps.now(), timezone);

  // 4. Reviews in the current + previous windows.
  const currentRows = await deps.findClassifiedReviewsForBusinessInPeriod({
    businessId,
    periodStart,
    periodEnd,
  });

  // 5. Skip if < 1 Review in the current window.
  if (currentRows.length < 1) {
    console.log(
      `[compose_digest] business ${businessId} has 0 Reviews in [${periodStart.toISOString()}, ${periodEnd.toISOString()}); skipping`,
    );
    return;
  }

  const previousRows = await deps.findClassifiedReviewsForBusinessInPeriod({
    businessId,
    periodStart: previousStart,
    periodEnd: periodStart,
  });

  // 6. Compute Theme aggregates for both windows.
  const currentReviews = currentRows.map(toClassifiedReview);
  const weekOverWeekTheme = buildWeekOverWeekTheme(currentRows, previousRows);

  // 7. Compose. composeDigest can throw — let pg-boss retry; we do NOT
  // persist a partial Digest.
  const body: DigestBody = await deps.composeDigest({
    reviews: currentReviews,
    business: { id: business.id, name: business.name, industry: business.industry ?? undefined },
    playbook: PLAYBOOK,
    weekOverWeekTheme,
    now: deps.now(),
  });

  // 8. Persist BEFORE sending so the audit trail is intact even if Resend
  // throws after success — the next AC requirement is "Persists the digests
  // row before sending".
  await deps.insertDigest({
    businessId: business.id,
    periodStart,
    periodEnd,
    body,
  });

  // 9. Emails.
  const recipients = await deps.findActiveOperatorEmailsForBusiness(business.id);
  if (recipients.length === 0) {
    console.warn(
      `[compose_digest] business ${business.id} has no active Operator emails; Digest row written, no email sent`,
    );
    return;
  }

  // 10. Render + send. One email per Operator so individual unsubscribe /
  // bounce paths stay clean (Resend's `to: string[]` puts them all on one
  // envelope which can mis-route per-recipient handling).
  const dashboardUrl = buildDashboardBaseUrl(deps.appBaseUrl);
  const html = renderDigestEmail({
    businessName: business.name,
    periodStart,
    periodEnd,
    body,
    dashboardUrl,
  });
  const subject = `${business.name}'s week in review`;
  for (const to of recipients) {
    await deps.sendEmail({ to: [to], subject, html });
  }
}

function toClassifiedReview(row: ClassifiedReviewRow): ClassifiedReview {
  return {
    id: row.review.id,
    starRating: row.review.starRating,
    redactedText: row.review.redactedText,
    postedAt: row.review.postedAt,
    themes: row.classification.themes as Theme[],
    sentiment: row.classification.sentiment as ClassifiedReview["sentiment"],
  };
}

function buildWeekOverWeekTheme(
  current: ClassifiedReviewRow[],
  previous: ClassifiedReviewRow[],
): Partial<Record<Theme, { current: number; previous: number }>> {
  const out: Partial<Record<Theme, { current: number; previous: number }>> = {};
  const bump = (theme: Theme, key: "current" | "previous") => {
    const slot = out[theme] ?? { current: 0, previous: 0 };
    slot[key] += 1;
    out[theme] = slot;
  };
  for (const row of current) {
    for (const t of row.classification.themes as Theme[]) bump(t, "current");
  }
  for (const row of previous) {
    for (const t of row.classification.themes as Theme[]) bump(t, "previous");
  }
  return out;
}

/**
 * Window math. Given a "now" instant and a Business's reference timezone,
 * return the period the Digest is summarising.
 *
 * The window is anchored to "the most recent Monday 00:00 local" — i.e. we
 * summarise the seven calendar days ending on Sunday. This is independent of
 * the cron schedule (which fires at Monday 08:00 local): even if the worker
 * runs Monday at 09:00 because of a delay, the period boundaries don't drift.
 *
 * Returns:
 *   periodStart  : Monday 00:00 local of (current week - 1), as a UTC Date
 *   periodEnd    : Monday 00:00 local of current week, as a UTC Date (exclusive)
 *   previousStart: Monday 00:00 local of (current week - 2), as a UTC Date
 */
export function computeDigestWindow(
  now: Date,
  timezone: string,
): { periodStart: Date; periodEnd: Date; previousStart: Date } {
  // Day-of-week / Y-M-D in the Business's timezone.
  const localYmd = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const localDow = Number(formatInTimeZone(now, timezone, "i")); // 1=Mon..7=Sun
  // Days since the most recent Monday in local time.
  const daysSinceMonday = (localDow - 1 + 7) % 7;
  const [yyyy, mm, dd] = localYmd.split("-").map(Number);
  // Local midnight today.
  const localMidnightToday = new Date(Date.UTC(yyyy, mm - 1, dd));
  // Walk back `daysSinceMonday` days to the Monday in local time.
  const localMondayThisWeekTimestamp = new Date(localMidnightToday);
  localMondayThisWeekTimestamp.setUTCDate(
    localMondayThisWeekTimestamp.getUTCDate() - daysSinceMonday,
  );
  const periodEnd = fromZonedTime(
    localMondayThisWeekTimestamp.toISOString().slice(0, 19),
    timezone,
  );
  // periodStart = periodEnd - 7 days
  const periodStart = new Date(periodEnd);
  periodStart.setUTCDate(periodStart.getUTCDate() - 7);
  const previousStart = new Date(periodStart);
  previousStart.setUTCDate(previousStart.getUTCDate() - 7);
  return { periodStart, periodEnd, previousStart };
}

function buildDashboardBaseUrl(override?: string): string {
  if (override) return `${override.replace(/\/$/, "")}/app/dashboard`;
  const base = process.env.APP_BASE_URL;
  if (!base) return "https://example.com/app/dashboard";
  return `${base.replace(/\/$/, "")}/app/dashboard`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hourly enqueuer — emits compose_digest jobs at Monday 08:00 per timezone.
// ─────────────────────────────────────────────────────────────────────────────

export interface ComposeDigestEnqueuerDeps {
  listActiveBusinesses: typeof listActiveBusinessesDefault;
  findBusinessReferenceTimezone: typeof findBusinessReferenceTimezoneDefault;
  enqueueComposeDigest: typeof enqueueComposeDigestDefault;
  now: () => Date;
}

export const DEFAULT_COMPOSE_DIGEST_ENQUEUER_DEPS: ComposeDigestEnqueuerDeps = {
  listActiveBusinesses: listActiveBusinessesDefault,
  findBusinessReferenceTimezone: findBusinessReferenceTimezoneDefault,
  enqueueComposeDigest: enqueueComposeDigestDefault,
  now: () => new Date(),
};

/**
 * Hourly cron callback. Iterates all active Businesses; for any whose local
 * clock is currently Monday 08:00, emits a `compose_digest` job.
 *
 * The `singletonKey` on each enqueue is `<business_id>-<isoYearWeek>` so
 * re-running this enqueuer within the same hour (worker restart, manual
 * trigger) cannot produce a second Digest job for the same week.
 *
 * pg-boss invokes `work()` callbacks with a batch (length-1 for cron). The
 * signature here matches `handleComposeDigest` so the worker registers it
 * the same way.
 */
export async function handleComposeDigestEnqueuer(
  jobs: Job<null>[],
  deps: ComposeDigestEnqueuerDeps = DEFAULT_COMPOSE_DIGEST_ENQUEUER_DEPS,
): Promise<void> {
  void jobs; // pg-boss schedule jobs carry no payload; we just tick.
  const now = deps.now();
  const businesses = await deps.listActiveBusinesses();
  for (const business of businesses) {
    const timezone = await deps.findBusinessReferenceTimezone(business.id);
    if (!isMondayEightAmLocal(now, timezone)) continue;
    const isoYearWeek = isoWeekKey(now, timezone);
    try {
      await deps.enqueueComposeDigest({ business_id: business.id }, { isoYearWeek });
    } catch (err) {
      // Don't let one Business's enqueue failure halt the whole tick — log
      // and keep going. The next hour's tick will retry (the singleton key
      // is the same, so a successful prior enqueue is the no-op case).
      console.error(
        `[compose_digest_enqueuer] enqueue failed for business=${business.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function isMondayEightAmLocal(now: Date, timezone: string): boolean {
  const dow = Number(formatInTimeZone(now, timezone, "i")); // 1=Mon..7=Sun
  const hour = Number(formatInTimeZone(now, timezone, "H"));
  return dow === 1 && hour === 8;
}

/** ISO year-week string in the Business's timezone, e.g. `2026-W21`. */
export function isoWeekKey(now: Date, timezone: string): string {
  // date-fns-tz `formatInTimeZone` supports tokens `R` (ISO week-year) and
  // `I` (ISO week-of-year). Two-digit pad on the week part.
  const isoYear = formatInTimeZone(now, timezone, "RRRR");
  const isoWeek = formatInTimeZone(now, timezone, "II");
  return `${isoYear}-W${isoWeek}`;
}

// Re-export for unit tests to assert on the time math without touching the DB.
export const _internals = { buildWeekOverWeekTheme };

// Re-export the Business type so the worker init code can be terse.
export type { Business };
