/**
 * Unit tests for the token encryption helpers.
 *
 * What's pinned:
 *  - round-trip: decrypt(encrypt(x)) === x
 *  - tamper-detection: decrypt rejects modified ciphertext / IV / tag
 *  - format: ciphertext is the documented `v1:iv:tag:data` shape
 *  - missing / wrong-length key: encryption helpers fail loudly, not silently
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetEncryptionKeyCacheForTests, decryptToken, encryptToken } from "../encrypt";

function setKey(bytes: number) {
  process.env.SOURCE_TOKEN_ENCRYPTION_KEY = randomBytes(bytes).toString("base64");
  __resetEncryptionKeyCacheForTests();
}

describe("encryptToken / decryptToken", () => {
  const originalKey = process.env.SOURCE_TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    setKey(32);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.SOURCE_TOKEN_ENCRYPTION_KEY;
    else process.env.SOURCE_TOKEN_ENCRYPTION_KEY = originalKey;
    __resetEncryptionKeyCacheForTests();
  });

  it("round-trips plaintext through encrypt → decrypt", () => {
    const plaintext = "ya29.example-access-token-12345";
    const ct = encryptToken(plaintext);
    expect(decryptToken(ct)).toBe(plaintext);
  });

  it("produces ciphertext in the documented v1:iv:tag:data format", () => {
    const ct = encryptToken("anything");
    const parts = ct.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    // base64 IV (12 bytes → 16 chars), tag (16 bytes → 24 chars). Loose check.
    expect(parts[1].length).toBeGreaterThanOrEqual(16);
    expect(parts[2].length).toBeGreaterThanOrEqual(20);
    expect(parts[3].length).toBeGreaterThan(0);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const a = encryptToken("same-input");
    const b = encryptToken("same-input");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe("same-input");
    expect(decryptToken(b)).toBe("same-input");
  });

  it("rejects ciphertext with a tampered data segment", () => {
    const ct = encryptToken("sensitive-token");
    const [v, iv, tag, data] = ct.split(":");
    // Flip one base64 char in data
    const flipped = data.startsWith("A") ? `B${data.slice(1)}` : `A${data.slice(1)}`;
    const tampered = [v, iv, tag, flipped].join(":");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("rejects a ciphertext with an unknown version prefix", () => {
    const ct = encryptToken("x");
    const replaced = ct.replace(/^v1:/, "v99:");
    expect(() => decryptToken(replaced)).toThrow(/unknown ciphertext version/);
  });

  it("rejects a malformed ciphertext (wrong segment count)", () => {
    expect(() => decryptToken("v1:notenoughparts")).toThrow(/malformed/);
  });

  it("throws if SOURCE_TOKEN_ENCRYPTION_KEY is unset", () => {
    delete process.env.SOURCE_TOKEN_ENCRYPTION_KEY;
    __resetEncryptionKeyCacheForTests();
    expect(() => encryptToken("x")).toThrow(/SOURCE_TOKEN_ENCRYPTION_KEY/);
  });

  it("throws if SOURCE_TOKEN_ENCRYPTION_KEY decodes to the wrong length", () => {
    setKey(16); // too short for AES-256
    expect(() => encryptToken("x")).toThrow(/32 bytes/);
  });
});
