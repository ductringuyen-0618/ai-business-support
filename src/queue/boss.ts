/**
 * pg-boss singleton + lifecycle helpers.
 *
 * Slice 1 wires the queue against the same Neon database (unpooled URL) and
 * exposes a single no-op `ping` job so the worker round-trip is provable in a
 * single `pnpm worker` shell. Slice 8 adds the `backfill_source` queue (the
 * OAuth callback enqueues; the consumer lands in slice 10). Subsequent slices
 * add `ingest_review`, `fire_incident`, `deliver_escalation`, `compose_digest`.
 */
import PgBoss from "pg-boss";

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

export interface PingPayload {
  message: string;
  at: string;
}

export interface BackfillSourcePayload {
  /** UUID of the `source_connections` row to backfill. */
  source_connection_id: string;
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
