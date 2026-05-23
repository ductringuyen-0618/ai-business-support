/**
 * pg-boss worker entrypoint.
 *
 * Run with `pnpm worker`. Subscribes to the queues we know about and stays up
 * until SIGINT / SIGTERM. Slice 1 wires the `ping` smoke-test handler;
 * slice 9 wires `ingest_review`; later slices add escalation, digest,
 * backfill, fire_incident handlers here.
 */
import {
  BACKFILL_SOURCE_JOB,
  INGEST_REVIEW_JOB,
  PING_JOB,
  startBoss,
  stopBoss,
} from "../queue/boss";
import { getIngestReviewConcurrency } from "../queue/config";
import { handleBackfillSource } from "../queue/handlers/backfill-source";
import { handleIngestReview } from "../queue/handlers/ingest-review";
import { handlePing } from "../queue/handlers/ping";

async function main() {
  console.log("[worker] starting pg-boss ...");
  const boss = await startBoss();

  // pg-boss v10 requires explicit queue creation before work().
  await boss.createQueue(PING_JOB);
  await boss.work(PING_JOB, handlePing);
  console.log(`[worker] subscribed to queue: ${PING_JOB}`);

  // `ingest_review` (slice 9). The per-Business concurrency cap from ADR-0007
  // maps onto pg-boss v10's `batchSize` — see src/queue/config.ts for the rationale.
  const ingestConcurrency = getIngestReviewConcurrency();
  await boss.createQueue(INGEST_REVIEW_JOB);
  await boss.work(INGEST_REVIEW_JOB, { batchSize: ingestConcurrency }, handleIngestReview);
  console.log(
    `[worker] subscribed to queue: ${INGEST_REVIEW_JOB} (batchSize=${ingestConcurrency})`,
  );

  // `backfill_source` (slice 10). One job per (Business, Source) connect;
  // each job walks every page of historical Reviews and enqueues an
  // `ingest_review` per Review. We run a small batch so a backlog of fresh
  // connects can drain in parallel without starving ingest. Per-Business
  // serialisation is enforced naturally by there being one job per
  // SourceConnection.
  await boss.createQueue(BACKFILL_SOURCE_JOB);
  await boss.work(BACKFILL_SOURCE_JOB, { batchSize: 2 }, handleBackfillSource);
  console.log(`[worker] subscribed to queue: ${BACKFILL_SOURCE_JOB} (batchSize=2)`);

  console.log("[worker] ready. press ctrl-c to stop.");
}

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, shutting down ...`);
  try {
    await stopBoss();
    process.exit(0);
  } catch (err) {
    console.error("[worker] error during shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch(async (err) => {
  console.error("[worker] fatal:", err);
  await stopBoss().catch(() => undefined);
  process.exit(1);
});
