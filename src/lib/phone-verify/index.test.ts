/**
 * Unit tests for the phone-verification helpers (slice 11).
 */
import { describe, expect, it } from "vitest";

import {
  constantTimeEquals,
  generateVerificationCode,
  hashVerificationCode,
  isPlausibleE164,
} from "./index";

describe("generateVerificationCode", () => {
  it("returns a zero-padded 6-digit string", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateVerificationCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe("hashVerificationCode", () => {
  it("returns a 64-char hex digest", () => {
    expect(hashVerificationCode("123456")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different hashes for different codes", () => {
    expect(hashVerificationCode("111111")).not.toBe(hashVerificationCode("222222"));
  });

  it("is deterministic", () => {
    expect(hashVerificationCode("424242")).toBe(hashVerificationCode("424242"));
  });
});

describe("constantTimeEquals", () => {
  it("returns true for identical hex digests", () => {
    const h = hashVerificationCode("424242");
    expect(constantTimeEquals(h, h)).toBe(true);
  });

  it("returns false for different digests", () => {
    expect(constantTimeEquals(hashVerificationCode("111111"), hashVerificationCode("222222"))).toBe(
      false,
    );
  });

  it("returns false for length mismatch (defensive)", () => {
    expect(constantTimeEquals("a".repeat(64), "a".repeat(60))).toBe(false);
  });
});

describe("isPlausibleE164", () => {
  it.each([
    ["+15555550123", true],
    ["+442012345678", true],
    ["+919876543210", true],
    ["5555550123", false], // missing +
    ["+1", false], // too short
    ["+", false],
    ["+abc12345", false], // non-digit
    ["+0123456789", false], // leading zero in country code
    ["", false],
  ])("isPlausibleE164(%j) == %s", (input, expected) => {
    expect(isPlausibleE164(input)).toBe(expected);
  });
});
