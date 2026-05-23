/**
 * Unit tests for the OAuth CSRF state helpers.
 *
 * Pins:
 *  - the cookie value verifies for the matching `state` and only the
 *    matching state
 *  - any tamper (cookie sig changed, query state changed, missing pieces)
 *    fails verification
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mintOAuthState, verifyOAuthState } from "../oauth-state";

const HARNESS_SECRET = "whsec_test_secret";

describe("oauth-state", () => {
  const original = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  beforeEach(() => {
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = HARNESS_SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    else process.env.CLERK_WEBHOOK_SIGNING_SECRET = original;
  });

  it("mintOAuthState produces a state + signed cookie that verify together", () => {
    const { state, cookieValue } = mintOAuthState();
    expect(state).toBeTruthy();
    expect(cookieValue.startsWith(`${state}.`)).toBe(true);
    expect(verifyOAuthState(state, cookieValue)).toBe(true);
  });

  it("rejects when state query param doesn't match the cookie", () => {
    const { cookieValue } = mintOAuthState();
    expect(verifyOAuthState("not-the-right-state", cookieValue)).toBe(false);
  });

  it("rejects when the cookie signature is tampered with", () => {
    const { state, cookieValue } = mintOAuthState();
    const [s, sig] = cookieValue.split(".");
    const flipped = sig.startsWith("A") ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(verifyOAuthState(state, `${s}.${flipped}`)).toBe(false);
  });

  it("rejects when state or cookie is missing", () => {
    expect(verifyOAuthState(null, "foo.bar")).toBe(false);
    expect(verifyOAuthState("foo", null)).toBe(false);
    expect(verifyOAuthState(null, null)).toBe(false);
  });

  it("rejects when the cookie lacks the signature separator", () => {
    expect(verifyOAuthState("abc", "abc-no-dot-sig")).toBe(false);
  });

  it("rejects if the signing secret has rotated under us", () => {
    const { state, cookieValue } = mintOAuthState();
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_different_secret";
    expect(verifyOAuthState(state, cookieValue)).toBe(false);
  });
});
