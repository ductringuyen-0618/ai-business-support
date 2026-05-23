/**
 * Pure-ish handler for `GET /api/sources/google/oauth/callback`, extracted
 * from `route.ts` so the integration tests can drive it without needing to
 * spin up a Next.js request pipeline.
 *
 * The route file is a thin adapter: it pulls the Clerk userId + cookies +
 * query params, calls into this module, and translates the result into a
 * `NextResponse`. Everything testable lives here.
 */
import { getOperatorWithBusinessByClerkUserId } from "@/db/queries/operators";
import { upsertGoogleConnection } from "@/db/queries/source-connections";
import type { SourceConnectionRow } from "@/db/schema";
import { exchangeGoogleAuthCode, GoogleOAuthError } from "@/lib/sources/google-oauth";
import { verifyOAuthState } from "@/lib/source-tokens/oauth-state";
import { enqueueBackfillSource } from "@/queue/boss";

export type CallbackOutcome =
  | {
      kind: "ok";
      sourceConnection: SourceConnectionRow;
      jobId: string | null;
    }
  | {
      kind: "redirect-sign-in";
    }
  | {
      kind: "redirect-dashboard";
      flash: "google_connected" | "google_state_mismatch" | "google_exchange_failed";
    };

export interface CallbackDeps {
  /** Override the global `fetch` in tests so we can stub Google. */
  fetchImpl?: typeof fetch;
  /** Override the enqueue side-effect in tests. */
  enqueue?: (sourceConnectionId: string) => Promise<string | null>;
}

export interface CallbackInput {
  clerkUserId: string | null;
  code: string | null;
  stateParam: string | null;
  stateCookie: string | null;
}

/**
 * Run the callback business logic. Returns a discriminated union the route
 * handler renders into HTTP redirects + cookie clears.
 *
 * The Operator's `business_id` comes from the Clerk session via
 * `getOperatorWithBusinessByClerkUserId`. We do NOT trust the OAuth `state`
 * to carry the business id — that's a separate authorisation check, and the
 * httpOnly Clerk session cookie is the more durable identity surface.
 */
export async function handleGoogleOAuthCallback(
  input: CallbackInput,
  deps: CallbackDeps = {},
): Promise<CallbackOutcome> {
  if (!input.clerkUserId) return { kind: "redirect-sign-in" };

  // 1. CSRF — the cookie must verify and match the `state` Google sent back.
  //    Order matters: check this BEFORE the token exchange so a forged request
  //    can't burn an authorization code.
  if (!verifyOAuthState(input.stateParam, input.stateCookie)) {
    return { kind: "redirect-dashboard", flash: "google_state_mismatch" };
  }

  if (!input.code) {
    return { kind: "redirect-dashboard", flash: "google_exchange_failed" };
  }

  // 2. Resolve the Operator → Business. If membership hasn't materialised yet
  //    (webhook race), we can't safely persist a row; surface the same flash
  //    as a token failure rather than 500ing.
  const membership = await getOperatorWithBusinessByClerkUserId(input.clerkUserId);
  if (!membership) {
    return { kind: "redirect-dashboard", flash: "google_exchange_failed" };
  }

  // 3. Exchange the code for tokens. Network/Google failure is a flash on the
  //    dashboard, not a 500 — the user can retry the connect flow.
  let tokens;
  try {
    tokens = await exchangeGoogleAuthCode(input.code, deps.fetchImpl);
  } catch (err) {
    if (!(err instanceof GoogleOAuthError)) throw err;
    // Log server-side; never echo the message to the client.
    console.error("[google-oauth] token exchange failed:", err.message);
    return { kind: "redirect-dashboard", flash: "google_exchange_failed" };
  }

  // 4. Persist the row (encrypted tokens) + enqueue the backfill job.
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const row = await upsertGoogleConnection({
    businessId: membership.business.id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
  });

  const enqueue = deps.enqueue ?? ((id) => enqueueBackfillSource({ source_connection_id: id }));
  const jobId = await enqueue(row.id);

  return { kind: "ok", sourceConnection: row, jobId };
}
