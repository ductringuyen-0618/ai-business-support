/**
 * Google OAuth helpers for the start + callback handlers.
 *
 * Scope decision: `business.manage` is the ONLY scope we request, and we
 * request it as a read-only consent (`access_type=offline` for refresh tokens
 * + `prompt=consent` so the refresh token is reliably issued). We never ask
 * for write scopes — see ADR-0003.
 *
 * The token-exchange call uses the global `fetch`. A `fetch` override is
 * supported via `exchangeGoogleAuthCode`'s second arg so the integration tests
 * can stub the Google response without monkey-patching globals.
 */

/**
 * The single read-only Business Profile scope. Per ADR-0003, we never request
 * any write scopes — Replies are drafted and copy-pasted by the Operator on
 * Google itself, not posted by our app.
 */
export const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/business.manage";

export const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  id_token?: string;
}

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

/**
 * Build the absolute URL we redirect the Operator's browser to in order to
 * start the Google consent flow. Pulls client id + base URL from env.
 */
export function buildGoogleAuthorizationUrl(opts: { state: string; redirectUri: string }): string {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    throw new GoogleOAuthError(
      "GOOGLE_OAUTH_CLIENT_ID is not set. Follow the Google Cloud runbook in README.md.",
    );
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPE,
    access_type: "offline",
    // `consent` forces Google to re-issue a refresh token on every connect —
    // without it, a re-auth from the same Operator returns access_token only
    // and we'd have no way to refresh later. The UX cost is one extra "allow"
    // click on reconnect, which is acceptable for an MVP.
    prompt: "consent",
    state: opts.state,
    // We don't ask for `include_granted_scopes` — we only ever request the
    // one read-only scope so there's nothing to incrementally combine with.
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}

/**
 * Build the redirect URI we ALSO register in the Google Cloud console. Must
 * match exactly or Google rejects the start request with `redirect_uri_mismatch`.
 */
export function googleCallbackUri(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) {
    throw new GoogleOAuthError(
      "APP_BASE_URL is not set. The OAuth callback URL is derived from it.",
    );
  }
  return `${base.replace(/\/$/, "")}/api/sources/google/oauth/callback`;
}

type FetchLike = typeof fetch;

/**
 * Exchange the authorization `code` for an access + refresh token pair.
 *
 * Pulls `client_secret` from env; throws `GoogleOAuthError` on any non-2xx or
 * malformed body. The caller (the callback handler) catches this and renders
 * a flash error rather than a 500 — token-exchange failure is a user-visible
 * "we couldn't connect; please try again" state.
 *
 * The `fetchImpl` override exists so integration tests can supply a stub that
 * reads a fixture JSON file instead of hitting the real Google endpoint.
 */
export async function exchangeGoogleAuthCode(
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<GoogleTokenResponse> {
  // E2E hook: short-circuit the real Google round-trip so the spec is hermetic.
  // The fake response is shaped exactly like what Google returns so downstream
  // persistence (token encryption, expiry calc) runs the production code path.
  if (process.env.E2E_TEST_MODE === "1") {
    return {
      access_token: `e2e-access-${code}`,
      refresh_token: `e2e-refresh-${code}`,
      expires_in: 3600,
      token_type: "Bearer",
      scope: GOOGLE_OAUTH_SCOPE,
    };
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GoogleOAuthError(
      "Google OAuth env vars missing: need GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
    );
  }
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: googleCallbackUri(),
    grant_type: "authorization_code",
  });

  let resp: Response;
  try {
    resp = await fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    throw new GoogleOAuthError("network error talking to Google token endpoint", err);
  }

  if (!resp.ok) {
    // Pull the body for context but don't put it on the user-facing flash —
    // Google's error bodies sometimes echo the request, which can contain the
    // (already-consumed) auth code.
    const text = await resp.text().catch(() => "");
    throw new GoogleOAuthError(
      `Google token endpoint returned ${resp.status}: ${text.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch (err) {
    throw new GoogleOAuthError("Google token response was not valid JSON", err);
  }

  if (!isGoogleTokenResponse(parsed)) {
    throw new GoogleOAuthError("Google token response missing required fields");
  }
  return parsed;
}

function isGoogleTokenResponse(v: unknown): v is GoogleTokenResponse {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.access_token === "string" &&
    typeof obj.refresh_token === "string" &&
    typeof obj.expires_in === "number"
  );
}
