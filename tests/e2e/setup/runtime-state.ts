/**
 * Shared on-disk state for the E2E run. `globalSetup` writes it; the spec +
 * `globalTeardown` read it. Living on disk (instead of `globalThis`) is the
 * only thing that works across Playwright's worker-process boundary.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface RuntimeState {
  databaseUrl: string;
  pgDataDir: string;
  mockRecorderPath: string;
  serverUrl: string;
  devPid: number;
  workerPid: number;
}

export function runtimeStatePath(): string {
  return path.resolve(__dirname, "..", ".runtime.json");
}

export function readRuntimeState(): RuntimeState {
  const p = runtimeStatePath();
  if (!existsSync(p)) {
    throw new Error(
      `Runtime state file not found at ${p}. Did globalSetup run? ` +
        "If you invoked the spec directly, use `pnpm test:e2e`.",
    );
  }
  return JSON.parse(readFileSync(p, "utf8")) as RuntimeState;
}
