/**
 * Centralised pg-boss tuning knobs.
 *
 * Per ADR-0007 the backfill worker has a per-Business concurrency cap to stay
 * under Anthropic's per-minute token budget. Slice 9 reuses that same cap for
 * `ingest_review` since it makes one LLM call per job — a busy backfill or a
 * burst of live Pub/Sub events can otherwise saturate the rate-limit window.
 *
 * Concretely we use `teamSize` on `boss.work()` to limit how many jobs the
 * worker processes in parallel. "Per-Business" is a slight misnomer at the
 * pg-boss layer (it caps per worker, not per Business key), but with the
 * single-worker MVP topology these are equivalent — and the cap is what we
 * actually want to constrain (concurrent Anthropic calls).
 *
 * Override via env `INGEST_REVIEW_CONCURRENCY` (positive integer) for ops
 * tuning without redeploying.
 */

/** Documented default; matches the ADR-0007 "5 per Business" wording. */
export const DEFAULT_INGEST_REVIEW_CONCURRENCY = 5;

/**
 * Maximum number of `ingest_review` jobs a worker will run in parallel.
 * Honoured by `boss.work(INGEST_REVIEW_JOB, { teamSize, teamConcurrency })`
 * in `src/worker/index.ts`.
 */
export function getIngestReviewConcurrency(): number {
  const raw = process.env.INGEST_REVIEW_CONCURRENCY;
  if (!raw) return DEFAULT_INGEST_REVIEW_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INGEST_REVIEW_CONCURRENCY;
  return parsed;
}

/**
 * pg-boss retry policy for `ingest_review` (issue #10 spec: up to 3 attempts
 * with backoff). pg-boss counts the initial attempt as #1, so `retryLimit: 2`
 * yields a total of 3 attempts. Exponential backoff is gated by
 * `retryBackoff: true`; `retryDelay` is the base delay in seconds.
 *
 * Exported separately from concurrency so a future incident-only path
 * (`fire_incident`) can pick a different policy without re-deriving these.
 */
export const INGEST_REVIEW_RETRY = {
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
} as const;
