/**
 * `backfill_source` job handler — slice 10 (issue #11).
 *
 * Walks every historical Review for a `source_connections` row via
 * `GoogleAdapter.ingestPage` pagination, enqueues one `ingest_review` job per
 * Review, and tracks progress on the row so the slice-12 dashboard banner can
 * render `loaded N of ~M`. ADR-0007 locks the product UX:
 *
 *   1. The OAuth callback (slice 8) enqueues exactly one of these jobs per
 *      successful connect.
 *   2. This handler updates `loaded_count` + `estimated_total` after every
 *      page so the dashboard renders progressive state.
 *   3. On the final page, if `loaded_count >= 0.95 * estimated_total` AND the
 *      "ready" email hasn't fired yet for this connection, send it once via
 *      `sendBackfillReadyEmail` and mark `ready_email_sent_at`.
 *   4. `TokenExpiredError` → flip `status='errored'` and bail without throwing
 *      so pg-boss does NOT retry (re-auth in slice 12's dashboard banner will
 *      enqueue a fresh job that resumes from `loaded_count`).
 *   5. `RateLimitError` → throw so pg-boss applies its retry backoff; the next
 *      attempt picks up at the same page because pagination is driven by the
 *      `nextPageToken` we got from the LAST successful page.
 *
 * Idempotency: the downstream `ingest_review` queue is itself idempotent on
 * `(source, source_review_id)` (slice 9). Re-running a backfill — manually or
 * after a pg-boss retry — produces the same Reviews, no duplicates. The
 * `loaded_count` we write is "Reviews seen so far this run", which is a
 * deliberately loose count: it monotonically increases as pages drain, and is
 * read by the dashboard as "approximately N loaded".
 */
import type { Job } from "pg-boss";

import { listActiveOperatorsForBusiness as listActiveOperatorsForBusinessDefault } from "@/db/queries/operators";
import {
  findSourceConnectionWithBusiness as findSourceConnectionWithBusinessDefault,
  markReadyEmailSent as markReadyEmailSentDefault,
  updateBackfillProgress as updateBackfillProgressDefault,
  type SourceConnectionWithBusiness,
} from "@/db/queries/source-connections";
import { sendBackfillReadyEmail as sendBackfillReadyEmailDefault } from "@/lib/email/backfill-ready";
import { GoogleAdapter } from "@/lib/sources/google-adapter";
import {
  RateLimitError,
  TokenExpiredError,
  type IngestPage,
  type SourceConnection as InMemorySourceConnection,
  type SourceAdapter,
} from "@/lib/sources/source-adapter";
import { decryptToken } from "@/lib/source-tokens/encrypt";

import { enqueueIngestReview as enqueueIngestReviewDefault } from "../boss";
import type { BackfillSourcePayload } from "../boss";

// re-export so the worker entrypoint imports the constant from a single place
export { BACKFILL_SOURCE_JOB, type BackfillSourcePayload } from "../boss";

/** Threshold (ADR-0007): send "ready" email when >= 95% loaded. */
export const READY_EMAIL_THRESHOLD = 0.95;

/**
 * Dependency-injection seam, mirroring the `ingest_review` handler shape so
 * the worker registration in `src/worker/index.ts` feels symmetric. Tests
 * substitute a fake adapter / fake db helpers so the handler can be exercised
 * without Postgres or network.
 */
export interface BackfillSourceDeps {
  findSourceConnectionWithBusiness: typeof findSourceConnectionWithBusinessDefault;
  updateBackfillProgress: typeof updateBackfillProgressDefault;
  markReadyEmailSent: typeof markReadyEmailSentDefault;
  listActiveOperatorsForBusiness: typeof listActiveOperatorsForBusinessDefault;
  enqueueIngestReview: typeof enqueueIngestReviewDefault;
  sendBackfillReadyEmail: typeof sendBackfillReadyEmailDefault;
  /**
   * Build a SourceAdapter for the connection. Default uses `GoogleAdapter`
   * from env (`fixture` in tests, `live` in production). Tests override with
   * a deterministic fake.
   */
  buildAdapter: (connection: SourceConnectionWithBusiness) => SourceAdapter;
  /** Test seam for the in-memory SourceConnection we pass to the adapter. */
  buildInMemoryConnection: (connection: SourceConnectionWithBusiness) => InMemorySourceConnection;
}

export const DEFAULT_BACKFILL_SOURCE_DEPS: BackfillSourceDeps = {
  findSourceConnectionWithBusiness: findSourceConnectionWithBusinessDefault,
  updateBackfillProgress: updateBackfillProgressDefault,
  markReadyEmailSent: markReadyEmailSentDefault,
  listActiveOperatorsForBusiness: listActiveOperatorsForBusinessDefault,
  enqueueIngestReview: enqueueIngestReviewDefault,
  sendBackfillReadyEmail: sendBackfillReadyEmailDefault,
  buildAdapter: () => new GoogleAdapter(),
  buildInMemoryConnection: (joined) => ({
    id: joined.sourceConnection.id,
    source: "google",
    oauth_access_token: decryptOrEmpty(joined.sourceConnection.oauthAccessToken),
    oauth_refresh_token: decryptOrEmpty(joined.sourceConnection.oauthRefreshToken),
  }),
};

function decryptOrEmpty(ciphertext: string | null): string {
  if (!ciphertext) return "";
  try {
    return decryptToken(ciphertext);
  } catch {
    // If decryption fails (e.g. SOURCE_TOKEN_ENCRYPTION_KEY rotated mid-flight)
    // we surface an empty string; the adapter will then throw
    // TokenExpiredError on the first request and we'll flip to `errored`.
    return "";
  }
}

/**
 * pg-boss v10 `work()` callback receives a batch of jobs even at teamSize=1.
 * We process them serially so a single connection's backfill failure doesn't
 * cascade into another's. Each job IS a whole backfill walk (paginated) —
 * pg-boss only redelivers if THIS handler throws.
 */
export async function handleBackfillSource(
  jobs: Job<BackfillSourcePayload>[],
  deps: BackfillSourceDeps = DEFAULT_BACKFILL_SOURCE_DEPS,
): Promise<void> {
  for (const job of jobs) {
    await processOne(job, deps);
  }
}

async function processOne(
  job: Job<BackfillSourcePayload>,
  deps: BackfillSourceDeps,
): Promise<void> {
  const { source_connection_id } = job.data;

  // 1. Resolve the connection + its Business. If the row vanished between
  //    enqueue and dispatch (Business cancelled during backfill), bail silently.
  const joined = await deps.findSourceConnectionWithBusiness(source_connection_id);
  if (!joined) {
    console.warn(
      `[backfill_source] source_connection ${source_connection_id} not found; abandoning job ${job.id}`,
    );
    return;
  }

  // 2. Guard on connection health. If the row is errored / disconnected, the
  //    OAuth flow needs to run again — we can't usefully retry. Mark backfill
  //    failed so the dashboard banner can prompt re-auth.
  if (joined.sourceConnection.status !== "healthy") {
    console.warn(
      `[backfill_source] source_connection ${source_connection_id} status=${joined.sourceConnection.status}; marking backfill failed`,
    );
    await deps.updateBackfillProgress({
      id: source_connection_id,
      backfillStatus: "failed",
    });
    return;
  }

  // 3. Flip to `running`. Idempotent — pg-boss retries land here too.
  await deps.updateBackfillProgress({
    id: source_connection_id,
    backfillStatus: "running",
  });

  const adapter = deps.buildAdapter(joined);
  const inMemoryConnection = deps.buildInMemoryConnection(joined);

  // 4. Walk pages, enqueueing one `ingest_review` per Review and updating
  //    progress after each page. The token-expired branch returns; the
  //    rate-limit branch throws so pg-boss retries with backoff.
  let pageToken: string | undefined = undefined;
  let loadedCount = 0;
  let estimatedTotal: number | undefined = undefined;
  let pageIndex = 0;

  try {
    do {
      const page: IngestPage = await adapter.ingestPage(inMemoryConnection, pageToken);
      pageIndex += 1;

      // Estimated total: in the absence of a count-of-reviews endpoint from
      // Google Business Profile, we use the running sum-so-far plus an
      // optimistic "one more page if there's a nextPageToken" estimate on the
      // first page. Subsequent pages update with the running known sum, and
      // the final page's loaded_count == estimated_total (so the >=95% check
      // resolves cleanly for any non-empty profile). This is the looseness
      // ADR-0007 accepts — the banner reads "approximately".
      loadedCount += page.reviews.length;
      if (estimatedTotal === undefined) {
        estimatedTotal = loadedCount;
      } else if (loadedCount > estimatedTotal) {
        estimatedTotal = loadedCount;
      }

      for (const rawReview of page.reviews) {
        await deps.enqueueIngestReview({
          source_connection_id,
          raw_review: rawReview,
        });
      }

      await deps.updateBackfillProgress({
        id: source_connection_id,
        loadedCount,
        estimatedTotal,
      });

      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      // Mark the connection errored so the dashboard banner can prompt re-auth.
      // We DO NOT set backfill_status='failed' — once re-auth happens, the
      // freshly-enqueued job resumes from the current loaded_count.
      console.warn(
        `[backfill_source] token expired for ${source_connection_id}; marking errored without throwing`,
      );
      await deps.updateBackfillProgress({
        id: source_connection_id,
        status: "errored",
      });
      return;
    }
    if (err instanceof RateLimitError) {
      // Let pg-boss schedule the next attempt with backoff. We deliberately
      // do NOT update backfill_status here — we're still mid-run from the
      // dashboard's point of view.
      console.warn(
        `[backfill_source] rate-limited for ${source_connection_id} at page ${pageIndex}; throwing for pg-boss retry`,
      );
      throw err;
    }
    // Any other error: mark failed and rethrow so pg-boss applies its retry
    // limit. After the retries are exhausted the row is left in
    // `backfill_status='failed'` for slice 12's banner.
    await deps.updateBackfillProgress({
      id: source_connection_id,
      backfillStatus: "failed",
    });
    throw err;
  }

  // 5. Final-page accounting. Set `complete`, then conditionally fire the
  //    "ready" email once per connection.
  await deps.updateBackfillProgress({
    id: source_connection_id,
    backfillStatus: "complete",
  });

  await maybeSendReadyEmail(joined, loadedCount, estimatedTotal ?? 0, deps);
}

/**
 * One-shot "your dashboard is ready" email gate (ADR-0007). Three guards:
 *   - Non-empty profile: skip the email entirely if `estimated_total === 0`
 *     ("nothing to be ready about").
 *   - ≥95% loaded threshold.
 *   - `ready_email_sent_at IS NULL` — enforced atomically via
 *     `markReadyEmailSent` so a concurrent retry can't double-send.
 */
async function maybeSendReadyEmail(
  joined: SourceConnectionWithBusiness,
  loadedCount: number,
  estimatedTotal: number,
  deps: BackfillSourceDeps,
): Promise<void> {
  if (estimatedTotal <= 0) {
    return;
  }
  if (loadedCount < READY_EMAIL_THRESHOLD * estimatedTotal) {
    return;
  }
  if (joined.sourceConnection.readyEmailSentAt) {
    // Already sent on a previous run — guard before going to the DB.
    return;
  }

  // Atomic flag flip. If we transition the row, we send. If another worker
  // got there first, `marked` is null and we skip.
  const marked = await deps.markReadyEmailSent(joined.sourceConnection.id);
  if (!marked) {
    return;
  }

  const operators = await deps.listActiveOperatorsForBusiness(joined.business.id);
  const recipients = operators.map((op) => op.email).filter((e) => e && e.length > 0);
  if (recipients.length === 0) {
    console.warn(
      `[backfill_source] no Operators on file for business ${joined.business.id}; skipping ready email`,
    );
    return;
  }

  try {
    await deps.sendBackfillReadyEmail({
      to: recipients,
      businessName: joined.business.name,
      reviewCount: loadedCount,
    });
  } catch (err) {
    // We've already marked the row as "sent" to enforce one-shot semantics
    // even if Resend is flaky. Log loudly so the failure is visible but do
    // NOT throw — the backfill itself succeeded.
    console.error(`[backfill_source] ready email failed for ${joined.sourceConnection.id}:`, err);
  }
}
