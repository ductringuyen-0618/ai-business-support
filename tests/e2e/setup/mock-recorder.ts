/**
 * File-backed recorder so mock services running INSIDE the Next dev server
 * process can publish their call log to the Playwright test process.
 *
 * Both processes resolve the same path via `E2E_MOCK_RECORDER_PATH` which the
 * `globalSetup` writes into the spawned dev server's env, then re-exports
 * via `process.env` so the spec also reads it.
 *
 * Why a file instead of TCP/IPC? Files are the lowest-common-denominator IPC,
 * survive crashes deterministically, and the volume is tiny (a handful of
 * JSON lines per spec). Each appended line is one event — JSONL.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { readRuntimeState } from "./runtime-state";

export interface MockEvent {
  service: "anthropic" | "resend" | "twilio";
  /** Wall-clock timestamp the event was recorded at, ISO 8601. */
  at: string;
  /** Free-form payload describing the call — shape depends on the service. */
  payload: unknown;
}

function path(): string {
  // The spec process doesn't inherit env vars from globalSetup, so we fall
  // back to the on-disk runtime state file.
  const p = process.env.E2E_MOCK_RECORDER_PATH ?? readRuntimeState().mockRecorderPath;
  return p;
}

export function readMockEvents(): MockEvent[] {
  const p = path();
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as MockEvent);
}

/** Reset the log between specs. */
export function resetMockEvents(): void {
  writeFileSync(path(), "");
}
