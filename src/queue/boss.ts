/**
 * pg-boss singleton + lifecycle helpers.
 *
 * Slice 1 wires the queue against the same Neon database (unpooled URL) and
 * exposes a single no-op `ping` job so the worker round-trip is provable in a
 * single `pnpm worker` shell. Subsequent slices add real jobs (`backfill_source`,
 * `ingest_review`, `fire_incident`, `deliver_escalation`, `compose_digest`).
 */
import PgBoss from "pg-boss";

export const PING_JOB = "ping" as const;

export interface PingPayload {
  message: string;
  at: string;
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
