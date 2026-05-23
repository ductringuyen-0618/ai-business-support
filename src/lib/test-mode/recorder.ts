/**
 * App-side companion to `tests/e2e/setup/mock-recorder.ts`. We can't import
 * from `tests/` into `src/` (alias + bundling concerns), so the writer lives
 * here and the Playwright spec uses the symmetrical reader.
 *
 * Format is JSON Lines — one `MockEvent` per line. The file is created by
 * `globalSetup` and its path lives in `E2E_MOCK_RECORDER_PATH`.
 */
import { appendFileSync } from "node:fs";

export interface MockEvent {
  service: "anthropic" | "resend" | "twilio";
  at: string;
  payload: unknown;
}

export function recordMockCall(event: Omit<MockEvent, "at">): void {
  const p = process.env.E2E_MOCK_RECORDER_PATH;
  if (!p) {
    // No recorder configured — drop the event silently. This keeps mock code
    // resilient when a developer runs the dev server with E2E_TEST_MODE=1 by
    // hand without the full Playwright harness.
    return;
  }
  const line = JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n";
  try {
    appendFileSync(p, line);
  } catch (err) {
    console.error("[e2e mock-recorder] append failed:", err);
  }
}
