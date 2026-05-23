/**
 * `ingest_review` job handler — the central ingest pipeline step (slice 9,
 * issue #10).
 *
 * Wires Redactor (ADR-0006) and Classifier (ADR-0004) together and persists
 * the resulting Review + Classification rows. Every other ingest path
 * (slice 10's backfill page consumer; slice 10's Pub/Sub fresh-Review
 * handler) funnels through this queue.
 *
 * Algorithm (in order — do not reorder; this is the contract from issue #10):
 *
 *   1. Look up the source_connection + its Business (for `businessProfile`).
 *   2. Build `knownNames` from `raw_review.reviewer_display_name`.
 *   3. Redact `raw_review.review_text` (null/empty → empty redacted_text).
 *   4. Upsert the `reviews` row keyed on `(source, source_review_id)`.
 *   5. Classify (one Anthropic call per ADR-0004).
 *   6. Upsert the `classifications` row keyed on `review_id`.
 *   7. If `is_incident`, enqueue `fire_incident` (slice 11 owns the handler).
 *
 * Step 5 may throw (Anthropic outage, Zod-invalid output twice in a row).
 * The handler intentionally lets that propagate so pg-boss schedules a
 * retry per `INGEST_REVIEW_RETRY` (`src/queue/config.ts`). The `reviews`
 * row from step 4 stays persisted — slice 12's dashboard surfaces it as
 * "unclassified" via the absent `classifications` row. After the third
 * attempt pg-boss marks the job failed.
 */
import type { Job } from "pg-boss";

import { upsertClassification as upsertClassificationDefault } from "@/db/queries/classifications";
import { upsertReviewBySourceId as upsertReviewBySourceIdDefault } from "@/db/queries/reviews";
import {
  type SourceConnectionWithBusiness,
  findSourceConnectionWithBusiness as findSourceConnectionWithBusinessDefault,
} from "@/db/queries/source-connections";
import { classify as classifyDefault, type Classification } from "@/lib/classifier";
import { redact as redactDefault } from "@/lib/redactor";

import {
  type IngestReviewPayload,
  enqueueFireIncident as enqueueFireIncidentDefault,
  enqueueIngestReview as enqueueIngestReviewBoss,
} from "../boss";

export { INGEST_REVIEW_JOB, type IngestReviewPayload } from "../boss";
export const enqueueIngestReview = enqueueIngestReviewBoss;

/**
 * Dependency-injection seam. Production code uses the defaults pointing at
 * Drizzle + the real Anthropic client; tests pass fakes so the handler can be
 * exercised without a DB or network. Mirrors the Classifier's `ClassifyOptions`
 * pattern so the two modules feel the same to wire.
 */
export interface IngestReviewDeps {
  findSourceConnectionWithBusiness: typeof findSourceConnectionWithBusinessDefault;
  upsertReviewBySourceId: typeof upsertReviewBySourceIdDefault;
  upsertClassification: typeof upsertClassificationDefault;
  redact: typeof redactDefault;
  classify: typeof classifyDefault;
  enqueueFireIncident: typeof enqueueFireIncidentDefault;
}

export const DEFAULT_INGEST_REVIEW_DEPS: IngestReviewDeps = {
  findSourceConnectionWithBusiness: findSourceConnectionWithBusinessDefault,
  upsertReviewBySourceId: upsertReviewBySourceIdDefault,
  upsertClassification: upsertClassificationDefault,
  redact: redactDefault,
  classify: classifyDefault,
  enqueueFireIncident: enqueueFireIncidentDefault,
};

/**
 * pg-boss v10 `work()` callback signature — receives a batch of jobs even at
 * `teamSize=1`. We process them serially inside the batch so an individual
 * Anthropic failure only fails its own job, not the whole batch.
 */
export async function handleIngestReview(
  jobs: Job<IngestReviewPayload>[],
  deps: IngestReviewDeps = DEFAULT_INGEST_REVIEW_DEPS,
): Promise<void> {
  for (const job of jobs) {
    await processOne(job, deps);
  }
}

async function processOne(job: Job<IngestReviewPayload>, deps: IngestReviewDeps): Promise<void> {
  const { source_connection_id, raw_review } = job.data;

  // 1. Resolve the Business behind this source_connection. If the row has
  // vanished between enqueue and dispatch (Business cancelled mid-backfill),
  // bail silently — there's nothing useful to do and re-throwing would just
  // spin pg-boss retries.
  const connection = await deps.findSourceConnectionWithBusiness(source_connection_id);
  if (!connection) {
    console.warn(
      `[ingest_review] source_connection ${source_connection_id} not found; abandoning job ${job.id}`,
    );
    return;
  }

  // 2. Build the knownNames list. Filter out null AND empty-string so the
  // Redactor never sees `""` in `knownNames` (that would build a regex that
  // matches everywhere).
  const knownNames =
    raw_review.reviewer_display_name && raw_review.reviewer_display_name.trim().length > 0
      ? [raw_review.reviewer_display_name]
      : [];

  // 3. Redact. ADR-0006 is the privacy brake — this is the chokepoint that
  // enforces "no raw Reviewer name ever reaches Anthropic". Star-only Reviews
  // (`review_text === null`) get an empty redacted_text; the Classifier still
  // produces a valid Classification from `starRating + businessProfile`.
  const redactedText = deps.redact(raw_review.review_text ?? "", knownNames);

  // 4. Upsert the Review row. Idempotent on (source, source_review_id) so a
  // re-delivered job (or a backfill + Pub/Sub race) lands in the same row.
  // We always persist redacted_text alongside the raw review_text so the
  // Deletion Request workflow can null the raw column without losing the
  // text Anthropic was shown.
  const reviewId = await deps.upsertReviewBySourceId({
    sourceConnectionId: connection.sourceConnection.id,
    source: connection.sourceConnection.source,
    sourceReviewId: raw_review.source_review_id,
    starRating: raw_review.star_rating,
    reviewText: raw_review.review_text,
    reviewerDisplayName: raw_review.reviewer_display_name,
    redactedText,
    postedAt: raw_review.posted_at,
  });

  // 5. Classify. ADR-0004 is the contract: one call, structured output. Any
  // error (LLM API failure or two-in-a-row invalid JSON) propagates so
  // pg-boss applies the configured retry policy. The Review row from step 4
  // is intentionally NOT rolled back — the dashboard surfaces unclassified
  // Reviews via the absent classifications row (slice 12).
  let classification: Classification;
  try {
    classification = await deps.classify({
      redactedText,
      starRating: raw_review.star_rating,
      postedAt: raw_review.posted_at,
      businessProfile: buildBusinessProfile(connection),
    });
  } catch (err) {
    console.error(
      `[ingest_review] classifier failed for review_id=${reviewId} (job ${job.id}):`,
      err,
    );
    throw err;
  }

  // 6. Upsert the Classification row. Keyed by review_id so re-classification
  // (prompt v2 rollout) overwrites in place.
  await deps.upsertClassification({
    reviewId,
    promptVersion: classification.prompt_version,
    isIncident: classification.is_incident,
    severity: classification.severity,
    themes: classification.themes,
    sentiment: classification.sentiment,
    suggestedReply: classification.suggested_reply,
  });

  // 7. If this Review is an Incident, kick off the Escalation pipeline. We
  // enqueue rather than call inline because Escalation has its own retry
  // semantics + per-Operator fan-out (slice 11). Slice 11 also owns
  // de-duping if the same Incident is enqueued twice — we just produce the
  // event.
  if (classification.is_incident) {
    await deps.enqueueFireIncident({ review_id: reviewId });
  }
}

function buildBusinessProfile(connection: SourceConnectionWithBusiness): {
  name: string;
  industry?: string;
} {
  // The Classifier's input schema treats `industry` as optional — we omit
  // the key entirely when the Business hasn't set one, rather than passing
  // `null`, so the cached prompt text is stable across Businesses that
  // share an industry.
  if (connection.business.industry) {
    return { name: connection.business.name, industry: connection.business.industry };
  }
  return { name: connection.business.name };
}
