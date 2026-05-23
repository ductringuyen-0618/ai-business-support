/**
 * Unit tests for the Google OAuth URL + token-exchange helpers.
 *
 * The OAuth start route uses `buildGoogleAuthorizationUrl` directly, so
 * pinning these params here proves the AC ("start returns 302 with correct
 * URL params + scope") without needing to spin up a Next.js request.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GOOGLE_OAUTH_SCOPE,
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthCode,
  googleCallbackUri,
} from "../google-oauth";

describe("buildGoogleAuthorizationUrl", () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("uses Google's hosted authorization endpoint", () => {
    const url = buildGoogleAuthorizationUrl({
      state: "abc",
      redirectUri: "http://localhost:3000/api/sources/google/oauth/callback",
    });
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
  });

  it("requests ONLY the read-only business.manage scope (ADR-0003)", () => {
    const url = buildGoogleAuthorizationUrl({
      state: "abc",
      redirectUri: "http://localhost:3000/cb",
    });
    const params = new URL(url).searchParams;
    expect(params.get("scope")).toBe(GOOGLE_OAUTH_SCOPE);
    expect(params.get("scope")).toBe("https://www.googleapis.com/auth/business.manage");
  });

  it("includes access_type=offline and prompt=consent so a refresh token is issued", () => {
    const url = buildGoogleAuthorizationUrl({ state: "abc", redirectUri: "http://x/cb" });
    const params = new URL(url).searchParams;
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("response_type")).toBe("code");
  });

  it("threads the supplied state through verbatim", () => {
    const url = buildGoogleAuthorizationUrl({ state: "csrf-xyz", redirectUri: "http://x/cb" });
    expect(new URL(url).searchParams.get("state")).toBe("csrf-xyz");
  });

  it("throws if GOOGLE_OAUTH_CLIENT_ID is unset", () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    expect(() => buildGoogleAuthorizationUrl({ state: "x", redirectUri: "http://x/cb" })).toThrow(
      /GOOGLE_OAUTH_CLIENT_ID/,
    );
  });
});

describe("googleCallbackUri", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("derives the callback path from APP_BASE_URL", () => {
    process.env.APP_BASE_URL = "https://app.example.com";
    expect(googleCallbackUri()).toBe("https://app.example.com/api/sources/google/oauth/callback");
  });

  it("strips a trailing slash on APP_BASE_URL", () => {
    process.env.APP_BASE_URL = "https://app.example.com/";
    expect(googleCallbackUri()).toBe("https://app.example.com/api/sources/google/oauth/callback");
  });
});

describe("exchangeGoogleAuthCode", () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret";
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("POSTs form-encoded body to the token endpoint and returns the parsed response", async () => {
    let captured: { url: string; body: string } | null = null;
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: typeof init?.body === "string" ? init.body : (init?.body?.toString() ?? ""),
      };
      return new Response(
        JSON.stringify({
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 60,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await exchangeGoogleAuthCode("auth-code-xyz", fakeFetch);
    expect(result.access_token).toBe("AT");
    expect(result.refresh_token).toBe("RT");
    expect(result.expires_in).toBe(60);

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://oauth2.googleapis.com/token");
    expect(captured!.body).toContain("code=auth-code-xyz");
    expect(captured!.body).toContain("grant_type=authorization_code");
    expect(captured!.body).toContain("client_id=id");
    expect(captured!.body).toContain("client_secret=secret");
  });

  it("throws GoogleOAuthError on non-2xx", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    await expect(exchangeGoogleAuthCode("bad", fakeFetch)).rejects.toThrow(/Google token endpoint/);
  });

  it("throws GoogleOAuthError on a 200 with missing fields", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: "only" }), { status: 200 })) as typeof fetch;
    await expect(exchangeGoogleAuthCode("incomplete", fakeFetch)).rejects.toThrow(
      /missing required fields/,
    );
  });
});
