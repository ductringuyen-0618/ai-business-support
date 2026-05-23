/**
 * `GET /api/sources/google/oauth/start`
 *
 * Kicks off the Google Business Profile OAuth consent flow.
 *
 * Flow:
 *   1. Confirm the caller is a signed-in Operator with a Business (Clerk
 *      session → operators row). Strangers and not-yet-onboarded users get
 *      redirected to sign-in / a friendly state.
 *   2. Mint a CSRF state token; stash its signed value in a short-lived
 *      httpOnly cookie.
 *   3. 302 the browser to Google's `accounts.google.com` with the read-only
 *      `business.manage` scope (ADR-0003) and our callback URI.
 *
 * The callback (`./callback/route.ts`) is responsible for verifying state,
 * exchanging the code, persisting the row, and enqueueing the backfill job.
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { buildGoogleAuthorizationUrl, googleCallbackUri } from "@/lib/sources/google-oauth";
import { OAUTH_STATE_COOKIE, mintOAuthState } from "@/lib/source-tokens/oauth-state";

export const runtime = "nodejs";

/** 10 minutes is plenty for a human to click through Google's consent screen. */
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 60 * 10;

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    // The middleware normally catches this, but `/api/*` may not always be
    // protected (e.g. for webhooks). Belt-and-braces.
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  const membership = await getOperatorWithBusinessByClerkUserId(userId);
  if (!membership) {
    // The Clerk webhook hasn't materialised the operator row yet (or the row
    // is soft-deleted). Bounce to the dashboard, which renders the "membership
    // pending" state, rather than starting an OAuth handshake we can't finish.
    return NextResponse.redirect(new URL("/app/dashboard", request.url));
  }

  const { state, cookieValue } = mintOAuthState();
  const redirectUrl = buildGoogleAuthorizationUrl({
    state,
    redirectUri: googleCallbackUri(),
  });

  const response = NextResponse.redirect(redirectUrl, { status: 302 });
  response.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: cookieValue,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
