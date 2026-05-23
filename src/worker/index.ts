/**
 * pg-boss worker entrypoint.
 *
 * Run with `pnpm worker`. Subscribes to the queues we know about and stays up
 * until SIGINT / SIGTERM. Slice 1 only registers the `ping` handler; later
 * slices add ingest, escalation, digest, backfill handlers here.
 */
import { PING_JOB, startBoss, stopBoss } from "../queue/boss";
import { handlePing } from "../queue/handlers/ping";

async function main() {
  console.log("[worker] starting pg-boss ...");
  const boss = await startBoss();

  // pg-boss v10 requires explicit queue creation before work().
  await boss.createQueue(PING_JOB);
  await boss.work(PING_JOB, handlePing);
  console.log(`[worker] subscribed to queue: ${PING_JOB}`);
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
