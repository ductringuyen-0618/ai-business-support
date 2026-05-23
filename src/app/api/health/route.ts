/**
 * Liveness probe. No auth, no DB read. Returns 200 with build info so a
 * Vercel/uptime check can confirm the function runtime is healthy.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "ai-business-support",
    time: new Date().toISOString(),
  });
}
