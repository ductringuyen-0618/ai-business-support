/**
 * pg-boss singleton + lifecycle helpers.
 *
 * Slice 1 wires the queue against the same Neon database (unpooled URL) and
 * exposes a single no-op `ping` job so the worker round-trip is provable in a
 * single `pnpm worker` shell. Slice 8 adds the `backfill_source` queue (the
 * OAuth callback enqueues; the consumer lands in slice 10). Slice 9 adds
 * `ingest_review` (this slice owns the handler) and the `fire_incident` queue
 * (slice 11 will own the handler). Subsequent slices add `deliver_escalation`,
 * `compose_digest`.
 */
import PgBoss from "pg-boss";

import type { Review } from "@/lib/sources/source-adapter";

import { INGEST_REVIEW_RETRY } from "./config";

export const PING_JOB = "ping" as const;

/**
 * `backfill_source` — slice 8 enqueues; slice 10 implements the consumer.
 *
 * Per ADR-0007 the OAuth callback persists the `source_connections` row and
 * enqueues exactly one job here; the worker (added in slice 10) pulls Reviews
 * page-by-page from the Source, runs them through the standard ingest
 * pipeline, and updates `loaded_count` / `backfill_status` as it goes.
 */
export const BACKFILL_SOURCE_JOB = "backfill_source" as const;

/**
 * The `ingest_review` queue (slice 9). One job per Review per ingest path
 * (live Pub/Sub or backfill page). Idempotent on `(source, source_review_id)`
 * — see `src/queue/handlers/ingest-review.ts`.
 */
export const INGEST_REVIEW_JOB = "ingest_review" as const;

/**
 * The `fire_incident` queue (slice 11). Slice 9 enqueues into it whenever a
 * Classification has `is_incident=true`; slice 11 adds the handler. We
 * declare the constant + queue helper here so slice 9 has a stable name to
 * enqueue against and slice 11 doesn't have to rename anything.
 */
export const FIRE_INCIDENT_JOB = "fire_incident" as const;

/**
 * The `deliver_escalation` queue (slice 11). One job per `escalations` row.
 * `fire_incident` enqueues with `startAfter = deliver_at` so quiet-hours-
 * deferred Escalations sit in pg-boss until their window ends; the consumer
 * sends through the Channel wrapper (Resend / Twilio) and flips
 * `escalations.status` from `queued` to `sent` (or `failed` after retry
 * exhaustion).
 */
export const DELIVER_ESCALATION_JOB = "deliver_escalation" as const;

export interface PingPayload {
  message: string;
  at: string;
}

export interface BackfillSourcePayload {
  /** UUID of the `source_connections` row to backfill. */
  source_connection_id: string;
}

/**
 * Payload for `ingest_review`. `raw_review` matches the shape produced by
 * `SourceAdapter.ingestPage()` — slice 10's backfill + Pub/Sub handlers will
 * call `enqueueIngestReview()` once per Review they pull.
 */
export interface IngestReviewPayload {
  source_connection_id: string;
  raw_review: Review;
}

/**
 * Payload for `fire_incident`. Slice 11 owns the handler; slice 9 only ever
 * writes. Kept minimal — the handler re-fetches the Review + Classification
 * from the DB rather than trust the queue payload.
 */
export interface FireIncidentPayload {
  review_id: string;
}

/**
 * Payload for `deliver_escalation` (slice 11). Kept minimal for the same
 * reason as `fire_incident` — the handler re-fetches the Escalation row +
 * its joined Incident / Review / Business so a stale payload doesn't drift
 * from the source of truth.
 */
export interface DeliverEscalationPayload {
  escalation_id: string;
}

function getQueueUrl(): string {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("pg-boss: DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL must be set.");
  }
  return url;
}

let _boss: PgBoss | undefined;
let _starting: Promise<PgBoss> | undefined;

/**
 * Get a started pg-boss instance. Safe to call from any process — first call
 * starts the instance; later calls reuse it. Idempotent.
 */
export async function startBoss(): Promise<PgBoss> {
  if (_boss) return _boss;
  if (_starting) return _starting;

  _starting = (async () => {
    const boss = new PgBoss({
      connectionString: getQueueUrl(),
      // Keep pg-boss schema namespaced so it doesn't collide with app tables.
      schema: "pgboss",
    });

    boss.on("error", (err) => {
      console.error("[pg-boss] error:", err);
    });

    await boss.start();
    _boss = boss;
    return boss;
  })();

  return _starting;
}

/**
 * Stop the pg-boss instance, if running. Call from a process shutdown handler.
 */
export async function stopBoss(): Promise<void> {
  if (_boss) {
    await _boss.stop({ graceful: true });
    _boss = undefined;
    _starting = undefined;
  }
}

/**
 * Enqueue a `ping` job. Smoke-test helper exposed at `/api/ping` and useful
 * for verifying the worker is consuming jobs.
 */
export async function enqueuePing(message: string): Promise<string | null> {
  const boss = await startBoss();
  // Ensure the queue exists (pg-boss v10 requires explicit createQueue).
  await boss.createQueue(PING_JOB);
  const payload: PingPayload = { message, at: new Date().toISOString() };
  return boss.send(PING_JOB, payload);
}

/**
 * Enqueue a `backfill_source` job. Called by the Google OAuth callback after
 * the `source_connections` row is persisted; the consumer is added in slice 10.
 *
 * `createQueue` is idempotent in pg-boss v10, so it's safe to call here before
 * the worker exists — the queue simply sits with one pending job until the
 * slice-10 worker comes online to drain it.
 */
export async function enqueueBackfillSource(
  payload: BackfillSourcePayload,
): Promise<string | null> {
  const boss = await startBoss();
  await boss.createQueue(BACKFILL_SOURCE_JOB);
  return boss.send(BACKFILL_SOURCE_JOB, payload);
}

/**
 * Enqueue an `ingest_review` job. Slice 10's backfill + Pub/Sub handlers call
 * this once per Review they pull. The retry policy lives in `./config.ts` so
 * one place tunes both the producer and the consumer.
 */
export async function enqueueIngestReview(payload: IngestReviewPayload): Promise<string | null> {
  const boss = await startBoss();
  await boss.createQueue(INGEST_REVIEW_JOB);
  return boss.send(INGEST_REVIEW_JOB, payload, INGEST_REVIEW_RETRY);
}

/**
 * Enqueue a `fire_incident` job. Called by `handleIngestReview` whenever a
 * Classification flips `is_incident=true`. Slice 11 implements the handler.
 */
export async function enqueueFireIncident(payload: FireIncidentPayload): Promise<string | null> {
  const boss = await startBoss();
  await boss.createQueue(FIRE_INCIDENT_JOB);
  return boss.send(FIRE_INCIDENT_JOB, payload);
}

/**
 * Enqueue a `deliver_escalation` job (slice 11). Called by `handleFireIncident`
 * once per `Delivery` returned by the `EscalationRouter`. `startAfter` carries
 * the router's quiet-hours-deferred `deliver_at` so pg-boss holds the job
 * until the window ends. We cap retries at 4 so a transient Resend / Twilio
 * outage retries with backoff (≈ 30s, 60s, 120s, 240s) before we give up and
 * mark the Escalation `failed` — that's the "Delivery failure recorded as
 * `escalations.status=failed`" acceptance criteria.
 */
export interface EnqueueDeliverEscalationOptions {
  /** When pg-boss is allowed to start the job. Defaults to "now". */
  startAfter?: Date;
}

export const DELIVER_ESCALATION_RETRY = {
  retryLimit: 4,
  retryDelay: 30,
  retryBackoff: true,
} as const;

export async function enqueueDeliverEscalation(
  payload: DeliverEscalationPayload,
  options: EnqueueDeliverEscalationOptions = {},
): Promise<string | null> {
  const boss = await startBoss();
  await boss.createQueue(DELIVER_ESCALATION_JOB);
  return boss.send(DELIVER_ESCALATION_JOB, payload, {
    ...DELIVER_ESCALATION_RETRY,
    ...(options.startAfter ? { startAfter: options.startAfter } : {}),
  });
}
