/**
 * `POST /api/webhooks/google/pubsub` — Google Pub/Sub push endpoint for
 * fresh Review notifications. Thin adapter; the logic lives in `./handler.ts`.
 *
 * Pub/Sub push subscriptions can authenticate either via a query-string token
 * (`?token=...`) or an `Authorization: Bearer ...` header depending on how
 * the subscription is configured in Google Cloud. We accept both — the
 * handler validates against `GOOGLE_PUBSUB_VERIFICATION_TOKEN`.
 *
 * Responses:
 *   - 401: missing or wrong token.
 *   - 400: malformed envelope or inner payload.
 *   - 204: success (including re-delivery of an already-processed message,
 *     and no-match payloads where the locationId hasn't been linked yet).
 *     Pub/Sub treats any 2xx as ack.
 */
import { NextResponse } from "next/server";

import { handleGooglePubsub } from "./handler";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const tokenQuery = url.searchParams.get("token");
  const authorizationHeader = request.headers.get("authorization");
  const rawBody = await request.text();

  const outcome = await handleGooglePubsub({
    authorizationHeader,
    tokenQuery,
    rawBody,
  });

  switch (outcome.kind) {
    case "unauthorized":
      return new NextResponse(null, { status: 401 });
    case "bad_request":
      return NextResponse.json({ ok: false, reason: outcome.reason }, { status: 400 });
    case "duplicate":
    case "no_match":
    case "ok":
      return new NextResponse(null, { status: 204 });
  }
}
