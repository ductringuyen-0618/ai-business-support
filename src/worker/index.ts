/**
 * pg-boss worker entrypoint.
 *
 * Run with `pnpm worker`. Subscribes to the queues we know about and stays up
 * until SIGINT / SIGTERM. Slice 1 wires the `ping` smoke-test handler;
 * slice 9 wires `ingest_review`; slice 10 wires `backfill_source`; slice 11
 * wires `fire_incident` + `deliver_escalation`; later slices add the digest
 * handler here.
 */
import {
  BACKFILL_SOURCE_JOB,
  COMPOSE_DIGEST_ENQUEUER_JOB,
  COMPOSE_DIGEST_JOB,
  DELIVER_ESCALATION_JOB,
  FIRE_INCIDENT_JOB,
  INGEST_REVIEW_JOB,
  PING_JOB,
  startBoss,
  stopBoss,
} from "../queue/boss";
import { getIngestReviewConcurrency } from "../queue/config";
import { handleBackfillSource } from "../queue/handlers/backfill-source";
import { handleComposeDigest, handleComposeDigestEnqueuer } from "../queue/handlers/compose-digest";
import { handleDeliverEscalation } from "../queue/handlers/deliver-escalation";
import { handleFireIncident } from "../queue/handlers/fire-incident";
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
  // connects can drain in parallel without starving ingest.
  await boss.createQueue(BACKFILL_SOURCE_JOB);
  await boss.work(BACKFILL_SOURCE_JOB, { batchSize: 2 }, handleBackfillSource);
  console.log(`[worker] subscribed to queue: ${BACKFILL_SOURCE_JOB} (batchSize=2)`);

  // `fire_incident` (slice 11). One Incident per Review at most.
  await boss.createQueue(FIRE_INCIDENT_JOB);
  await boss.work(FIRE_INCIDENT_JOB, handleFireIncident);
  console.log(`[worker] subscribed to queue: ${FIRE_INCIDENT_JOB}`);

  // `deliver_escalation` (slice 11). One outbound Email or SMS per job.
  // `includeMetadata` exposes `retryCount` so the handler can mark the
  // Escalation `failed` on the final attempt.
  await boss.createQueue(DELIVER_ESCALATION_JOB);
  await boss.work(
    DELIVER_ESCALATION_JOB,
    { batchSize: 5, includeMetadata: true },
    handleDeliverEscalation,
  );
  console.log(`[worker] subscribed to queue: ${DELIVER_ESCALATION_JOB}`);

  // `compose_digest` (slice 14). One job per (Business, week) emitted by the
  // hourly enqueuer below. Single-threaded — Anthropic + Resend are the
  // bottleneck, not pg-boss.
  await boss.createQueue(COMPOSE_DIGEST_JOB);
  await boss.work(COMPOSE_DIGEST_JOB, handleComposeDigest);
  console.log(`[worker] subscribed to queue: ${COMPOSE_DIGEST_JOB}`);

  // `compose_digest_enqueuer` (slice 14). pg-boss's cron is UTC-only, so we
  // tick every hour on the hour and let the handler decide per Business
  // (via its reference timezone) whether to emit a `compose_digest` job.
  // The hourly cadence is the lowest-precision unit that lets us hit
  // Monday 08:00 in every timezone exactly once per week per Business.
  await boss.createQueue(COMPOSE_DIGEST_ENQUEUER_JOB);
  await boss.work(COMPOSE_DIGEST_ENQUEUER_JOB, handleComposeDigestEnqueuer);
  await boss.schedule(COMPOSE_DIGEST_ENQUEUER_JOB, "0 * * * *");
  console.log(
    `[worker] subscribed to queue: ${COMPOSE_DIGEST_ENQUEUER_JOB} (scheduled hourly @ 0 * * * *)`,
  );

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
