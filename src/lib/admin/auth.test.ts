/**
 * Unit tests for the admin allowlist helper. The helper is a sharp safety
 * gate — a bug here silently widens internal endpoint access — so each
 * branch gets its own test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isAdmin } from "./auth";

const original = process.env.ADMIN_USER_IDS;

beforeEach(() => {
  delete process.env.ADMIN_USER_IDS;
});

afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_USER_IDS;
  else process.env.ADMIN_USER_IDS = original;
});

describe("isAdmin", () => {
  it("returns false for null userId regardless of env", () => {
    process.env.ADMIN_USER_IDS = "user_a,user_b";
    expect(isAdmin(null)).toBe(false);
  });

  it("returns false when env var is unset", () => {
    expect(isAdmin("user_a")).toBe(false);
  });

  it("returns false when env var is empty", () => {
    process.env.ADMIN_USER_IDS = "";
    expect(isAdmin("user_a")).toBe(false);
  });

  it("returns true when the id is in the comma-separated list", () => {
    process.env.ADMIN_USER_IDS = "user_a,user_b,user_c";
    expect(isAdmin("user_b")).toBe(true);
  });

  it("trims whitespace around comma-separated entries", () => {
    process.env.ADMIN_USER_IDS = " user_a , user_b , user_c ";
    expect(isAdmin("user_b")).toBe(true);
  });

  it("returns false for ids not in the list", () => {
    process.env.ADMIN_USER_IDS = "user_a,user_b";
    expect(isAdmin("user_c")).toBe(false);
  });

  it("re-reads env on every call (no module-load caching)", () => {
    process.env.ADMIN_USER_IDS = "user_a";
    expect(isAdmin("user_a")).toBe(true);
    process.env.ADMIN_USER_IDS = "user_b";
    expect(isAdmin("user_a")).toBe(false);
    expect(isAdmin("user_b")).toBe(true);
  });
});
