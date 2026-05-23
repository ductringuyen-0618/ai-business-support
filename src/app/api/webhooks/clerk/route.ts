/**
 * Clerk → app webhook receiver.
 *
 * Clerk signs every webhook with Svix; we verify the signature against
 * `CLERK_WEBHOOK_SIGNING_SECRET` before touching the body. Unsigned or
 * wrong-signature requests get a flat 401 (Clerk treats anything in 4xx as
 * "do not retry"); transient DB errors get a 500 so Clerk retries with its
 * built-in backoff.
 *
 * Per ADR-0009 these events are the source of truth for our local Business +
 * Operator rows. The handlers themselves live in `src/webhooks/clerk-events.ts`
 * so they can be unit-tested without spinning up Next's request plumbing.
 */
import { headers as nextHeaders } from "next/headers";
import { NextResponse } from "next/server";
import { Webhook } from "svix";

import { getDb } from "@/db/client";
import { applyClerkEvent, WebhookPayloadError, type ClerkEvent } from "@/webhooks/clerk-events";

// Webhook receivers do not need Next's edge runtime; the Node runtime gives us
// access to the same `postgres` / `@neondatabase/serverless` clients used
// elsewhere on the server, and Clerk's payloads are tiny.
export const runtime = "nodejs";
// Webhooks are inherently dynamic — never let Next try to prerender this.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    // Surface configuration drift loudly: returning 500 makes Clerk retry,
    // which is what we want until an operator notices and sets the env var.
    console.error("CLERK_WEBHOOK_SIGNING_SECRET is not set");
    return new NextResponse("server misconfigured", { status: 500 });
  }

  const rawBody = await request.text();
  const event = await verifyClerkSignature(rawBody, secret);
  if (!event) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  try {
    const outcome = await applyClerkEvent(getDb(), event);
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    if (err instanceof WebhookPayloadError) {
      // 400 = Clerk records as failure but stops retrying. Malformed payloads
      // won't get healed by retries; alert and move on.
      console.error("clerk webhook payload error:", err.message);
      return new NextResponse(err.message, { status: 400 });
    }
    // Anything else (DB blip, network, etc.) → 500 so Clerk retries.
    console.error("clerk webhook handler error:", err);
    return new NextResponse("internal error", { status: 500 });
  }
}

/**
 * Verify the Svix signature and parse the payload.
 *
 * Returns the parsed event on success and `null` on any verification failure.
 * We pull the three Svix headers manually so missing headers are also a clean
 * "invalid signature" result rather than an internal throw.
 */
async function verifyClerkSignature(rawBody: string, secret: string): Promise<ClerkEvent | null> {
  const h = await nextHeaders();
  const svixId = h.get("svix-id");
  const svixTimestamp = h.get("svix-timestamp");
  const svixSignature = h.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) return null;

  try {
    const wh = new Webhook(secret);
    return wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkEvent;
  } catch {
    return null;
  }
}
