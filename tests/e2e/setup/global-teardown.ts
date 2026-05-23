/**
 * Tear down everything `globalSetup` started, in reverse order:
 *   1. Stop the pg-boss worker (SIGTERM).
 *   2. Stop the Next dev server (SIGTERM).
 *   3. Stop the temp Postgres cluster and remove its data dir.
 *
 * We tolerate failure at every step — the goal of teardown is to leave a clean
 * machine, not to surface errors. Errors from setup already failed loudly.
 */
import { rm } from "node:fs/promises";

import { stopTempPostgres } from "./postgres";
import { runtimeStatePath, type RuntimeState } from "./runtime-state";

interface Handles {
  pg: { dataDir: string; port: number; url: string };
  dev: { proc: { kill(signal?: string): boolean; pid?: number } };
  worker: { kill(signal?: string): boolean; pid?: number };
}

function killByPid(pid: number, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

async function readState(): Promise<RuntimeState | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(runtimeStatePath(), "utf8");
    return JSON.parse(raw) as RuntimeState;
  } catch {
    return null;
  }
}

export default async function globalTeardown(): Promise<void> {
  const handles = (globalThis as { __E2E_HANDLES__?: Handles }).__E2E_HANDLES__;
  const state = await readState();

  if (handles?.worker) {
    try {
      handles.worker.kill("SIGTERM");
    } catch {
      /* noop */
    }
  } else if (state?.workerPid) {
    killByPid(state.workerPid, "SIGTERM");
  }

  if (handles?.dev?.proc) {
    try {
      handles.dev.proc.kill("SIGTERM");
    } catch {
      /* noop */
    }
  } else if (state?.devPid) {
    killByPid(state.devPid, "SIGTERM");
  }

  // Give the processes a moment to drain before killing the database out
  // from under them.
  await new Promise((r) => setTimeout(r, 750));

  if (handles?.pg) {
    await stopTempPostgres(handles.pg);
  } else if (state) {
    await stopTempPostgres({
      dataDir: state.pgDataDir,
      port: 0,
      url: state.databaseUrl,
    });
  }

  // Best-effort cleanup of the runtime state file.
  try {
    await rm(runtimeStatePath(), { force: true });
  } catch {
    /* noop */
  }
}
