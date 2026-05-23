/**
 * Integration tests for the Google OAuth callback handler.
 *
 * Exercises `handleGoogleOAuthCallback` end-to-end against:
 *   - mocked `getOperatorWithBusinessByClerkUserId` (no Clerk JWT round-trip)
 *   - mocked `upsertGoogleConnection` (no live DB)
 *   - mocked `fetch` that serves the recorded fixtures under
 *     `../__fixtures__/`
 *
 * The mocks are wired with `vi.mock` against the handler's named imports so
 * the test focuses on the pure orchestration logic: state validation, token
 * exchange, persistence call, enqueue call, redirect outcome.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mintOAuthState } from "@/lib/source-tokens/oauth-state";

const HARNESS_CLERK_USER = "user_test_123";
const HARNESS_BUSINESS_ID = "11111111-1111-1111-1111-111111111111";
const HARNESS_CONNECTION_ID = "22222222-2222-2222-2222-222222222222";

const tokenSuccess = JSON.parse(
  readFileSync(path.join(__dirname, "..", "__fixtures__", "token-success.json"), "utf8"),
) as Record<string, unknown>;
const tokenError = JSON.parse(
  readFileSync(path.join(__dirname, "..", "__fixtures__", "token-error.json"), "utf8"),
) as Record<string, unknown>;

// Mock the DB / queue boundary modules. The handler only depends on these
// three external functions; everything else is pure.
vi.mock("@/db/queries/operators", () => ({
  getOperatorWithBusinessByClerkUserId: vi.fn(),
}));
vi.mock("@/db/queries/source-connections", () => ({
  upsertGoogleConnection: vi.fn(),
}));
// Stub the boss module so the handler's default `enqueue` doesn't reach for
// `startBoss()` (which would try to open a real DB connection).
vi.mock("@/queue/boss", () => ({
  enqueueBackfillSource: vi.fn(),
}));

const operatorsMock = await import("@/db/queries/operators");
const sourceConnectionsMock = await import("@/db/queries/source-connections");
const queueMock = await import("@/queue/boss");
const { handleGoogleOAuthCallback } =
  await import("@/app/api/sources/google/oauth/callback/handler");

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("handleGoogleOAuthCallback", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    vi.resetAllMocks();
    // Required env. Encryption key is base64 of 32 'a' bytes.
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_test_secret";
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
    process.env.SOURCE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

    vi.mocked(operatorsMock.getOperatorWithBusinessByClerkUserId).mockResolvedValue({
      operator: {
        id: "op_1",
        clerkUserId: HARNESS_CLERK_USER,
        businessId: HARNESS_BUSINESS_ID,
        email: "op@example.com",
        name: "Op",
        createdAt: new Date(),
        deletedAt: null,
      },
      business: {
        id: HARNESS_BUSINESS_ID,
        clerkOrgId: "org_1",
        name: "Test Diner",
        industry: null,
        createdAt: new Date(),
        cancelledAt: null,
      },
    });
    vi.mocked(sourceConnectionsMock.upsertGoogleConnection).mockResolvedValue({
      id: HARNESS_CONNECTION_ID,
      businessId: HARNESS_BUSINESS_ID,
      source: "google",
      oauthAccessToken: "ciphertext",
      oauthRefreshToken: "ciphertext",
      oauthExpiresAt: new Date(Date.now() + 3600 * 1000),
      status: "healthy",
      backfillStatus: "pending",
      loadedCount: 0,
      estimatedTotal: null,
      createdAt: new Date(),
      disconnectedAt: null,
      googleLocationId: null,
      readyEmailSentAt: null,
    });
    vi.mocked(queueMock.enqueueBackfillSource).mockResolvedValue("job_1");
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("happy path: valid state + code → upserts row, enqueues backfill, returns ok", async () => {
    const { state, cookieValue } = mintOAuthState();

    const outcome = await handleGoogleOAuthCallback(
      {
        clerkUserId: HARNESS_CLERK_USER,
        code: "good-auth-code",
        stateParam: state,
        stateCookie: cookieValue,
      },
      { fetchImpl: fakeFetch(tokenSuccess) },
    );

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.sourceConnection.id).toBe(HARNESS_CONNECTION_ID);
    expect(outcome.jobId).toBe("job_1");

    expect(sourceConnectionsMock.upsertGoogleConnection).toHaveBeenCalledTimes(1);
    const upsertArgs = vi.mocked(sourceConnectionsMock.upsertGoogleConnection).mock.calls[0][0];
    expect(upsertArgs.businessId).toBe(HARNESS_BUSINESS_ID);
    expect(upsertArgs.accessToken).toBe(tokenSuccess.access_token);
    expect(upsertArgs.refreshToken).toBe(tokenSuccess.refresh_token);
    // expires_in (3599 seconds) → expiresAt approximately one hour from now.
    expect(upsertArgs.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3000 * 1000);

    expect(queueMock.enqueueBackfillSource).toHaveBeenCalledWith({
      source_connection_id: HARNESS_CONNECTION_ID,
    });
  });

  it("rejects mismatched state → redirect to dashboard with state-mismatch flash, no row persisted", async () => {
    const { state } = mintOAuthState();
    // Cookie value belongs to a different state — verify must fail.
    const { cookieValue: differentCookie } = mintOAuthState();

    const outcome = await handleGoogleOAuthCallback(
      {
        clerkUserId: HARNESS_CLERK_USER,
        code: "good-auth-code",
        stateParam: state,
        stateCookie: differentCookie,
      },
      { fetchImpl: fakeFetch(tokenSuccess) },
    );

    expect(outcome).toEqual({ kind: "redirect-dashboard", flash: "google_state_mismatch" });
    expect(sourceConnectionsMock.upsertGoogleConnection).not.toHaveBeenCalled();
    expect(queueMock.enqueueBackfillSource).not.toHaveBeenCalled();
  });

  it("token exchange failure → redirect with exchange-failed flash, no row persisted", async () => {
    const { state, cookieValue } = mintOAuthState();

    const outcome = await handleGoogleOAuthCallback(
      {
        clerkUserId: HARNESS_CLERK_USER,
        code: "expired-auth-code",
        stateParam: state,
        stateCookie: cookieValue,
      },
      { fetchImpl: fakeFetch(tokenError, 400) },
    );

    expect(outcome).toEqual({ kind: "redirect-dashboard", flash: "google_exchange_failed" });
    expect(sourceConnectionsMock.upsertGoogleConnection).not.toHaveBeenCalled();
    expect(queueMock.enqueueBackfillSource).not.toHaveBeenCalled();
  });

  it("missing clerk session → redirect to sign-in", async () => {
    const outcome = await handleGoogleOAuthCallback(
      {
        clerkUserId: null,
        code: "x",
        stateParam: "y",
        stateCookie: "y.bogus",
      },
      { fetchImpl: fakeFetch(tokenSuccess) },
    );
    expect(outcome).toEqual({ kind: "redirect-sign-in" });
  });

  it("missing code on callback → redirect with exchange-failed flash", async () => {
    const { state, cookieValue } = mintOAuthState();
    const outcome = await handleGoogleOAuthCallback(
      {
        clerkUserId: HARNESS_CLERK_USER,
        code: null,
        stateParam: state,
        stateCookie: cookieValue,
      },
      { fetchImpl: fakeFetch(tokenSuccess) },
    );
    expect(outcome).toEqual({ kind: "redirect-dashboard", flash: "google_exchange_failed" });
    expect(sourceConnectionsMock.upsertGoogleConnection).not.toHaveBeenCalled();
  });

  it("operator not yet materialised → redirect with exchange-failed flash, no row persisted", async () => {
    vi.mocked(operatorsMock.getOperatorWithBusinessByClerkUserId).mockResolvedValue(null);
    const { state, cookieValue } = mintOAuthState();

    const outcome = await handleGoogleOAuthCallback(
      {
        clerkUserId: HARNESS_CLERK_USER,
        code: "good-code",
        stateParam: state,
        stateCookie: cookieValue,
      },
      { fetchImpl: fakeFetch(tokenSuccess) },
    );

    expect(outcome).toEqual({ kind: "redirect-dashboard", flash: "google_exchange_failed" });
    expect(sourceConnectionsMock.upsertGoogleConnection).not.toHaveBeenCalled();
  });
});
