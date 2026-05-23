/**
 * CSRF protection for the Google OAuth round-trip.
 *
 * The `state` parameter Google round-trips back to our callback must be tied
 * to the Operator's browser session so an attacker can't trick a victim into
 * connecting their own Google account to the victim's Business.
 *
 * Mechanism:
 *  1. Server generates 16 random bytes → base64url → that's the `state` we
 *     send to Google in the redirect.
 *  2. Server stores the same value, signed with HMAC-SHA256 keyed by
 *     `CLERK_WEBHOOK_SIGNING_SECRET` (it's the only app-side secret we
 *     guarantee is set in every env; rotating it invalidates pending OAuth
 *     starts, which is fine — they expire in 10 minutes anyway), in a
 *     short-lived httpOnly cookie.
 *  3. Callback reads cookie, verifies HMAC, asserts `state` matches.
 *
 * We deliberately do NOT sign the operator id into the state — the OAuth
 * callback derives the operator from the Clerk session cookie instead, which
 * is itself httpOnly + same-site. This means state mismatch is the only
 * thing to defend against, which keeps the cookie tiny.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OAUTH_STATE_COOKIE = "abs_google_oauth_state";
const STATE_BYTES = 16;

function getStateSigningSecret(): string {
  // Reuse the Clerk webhook secret — it's already required in every env. We
  // don't surface a separate env var because that's one more thing for an
  // operator (the human running the deploy, not our Operator) to fumble. If
  // CLERK_WEBHOOK_SIGNING_SECRET is missing we fail loudly rather than fall
  // back to a hard-coded default.
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    throw new Error(
      "OAuth state signing requires CLERK_WEBHOOK_SIGNING_SECRET. " +
        "Add it to .env.local — see .env.example.",
    );
  }
  return secret;
}

/**
 * Mint a fresh state value and its signed cookie payload. Caller writes
 * `cookieValue` to the `OAUTH_STATE_COOKIE` (httpOnly, short max-age) and
 * sends `state` to Google in the redirect URL.
 */
export function mintOAuthState(): { state: string; cookieValue: string } {
  const state = randomBytes(STATE_BYTES).toString("base64url");
  const sig = createHmac("sha256", getStateSigningSecret()).update(state).digest("base64url");
  return { state, cookieValue: `${state}.${sig}` };
}

/**
 * Verify the `state` query param matches the signed cookie. Returns `false`
 * for any malformation; only returns `true` when the HMAC verifies and the
 * embedded state matches the query-param state.
 *
 * Uses `timingSafeEqual` so an attacker can't byte-by-byte guess the HMAC.
 */
export function verifyOAuthState(stateParam: string | null, cookieValue: string | null): boolean {
  if (!stateParam || !cookieValue) return false;
  const dot = cookieValue.indexOf(".");
  if (dot < 0) return false;
  const cookieState = cookieValue.slice(0, dot);
  const cookieSig = cookieValue.slice(dot + 1);
  if (cookieState !== stateParam) return false;

  const expectedSig = createHmac("sha256", getStateSigningSecret())
    .update(cookieState)
    .digest("base64url");
  const a = Buffer.from(cookieSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
