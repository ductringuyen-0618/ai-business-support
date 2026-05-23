/**
 * `ping` job handler. No-op smoke test that prints the payload to stdout so
 * an Operator running `pnpm worker` can see the round-trip working.
 */
import type { Job } from "pg-boss";

import type { PingPayload } from "../boss";

export async function handlePing(jobs: Job<PingPayload>[]): Promise<void> {
  for (const job of jobs) {
    console.log(
      `[worker] ping received id=${job.id} message=${JSON.stringify(job.data.message)} sent_at=${job.data.at}`,
    );
  }
}
