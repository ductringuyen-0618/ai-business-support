/**
 * Smoke test: enqueue a no-op `ping` job onto pg-boss.
 *
 * Used during Slice 1 to prove the queue round-trip works end-to-end. Run the
 * worker (`pnpm worker`) in one shell, then POST to /api/ping from another —
 * you should see the message logged by the worker within a few seconds.
 *
 * Lives outside `/app/*` so it stays unauthenticated for now; a later slice
 * will either remove it or move it behind an admin-only check.
 */
import { NextResponse } from "next/server";

import { enqueuePing } from "@/queue/boss";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message : "hello from /api/ping";
  const jobId = await enqueuePing(message);
  return NextResponse.json({ ok: true, jobId, message });
}
