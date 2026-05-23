/**
 * Helpers for the phone-verification round-trip (slice 11).
 *
 * We intentionally avoid Twilio's Verify API (which requires a separately
 * provisioned Verify Service) — for MVP we generate a 6-digit code locally,
 * SMS it via the existing Twilio wrapper, and compare hashes server-side.
 *
 * Plaintext codes never touch the DB. We store `sha256(code)` and compare in
 * constant time so a SQL injection or DB dump can't be replayed.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export const VERIFICATION_CODE_TTL_SECONDS = 10 * 60;

/**
 * Generate a uniformly-random 6-digit code as a zero-padded string. Using
 * `randomInt` (not `Math.random`) so we don't seed CSPRNG decisions from the
 * V8 PRNG.
 */
export function generateVerificationCode(): string {
  const n = randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}

export function hashVerificationCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hashes. Both inputs are hex digests so we
 * compare their byte buffers — `timingSafeEqual` requires equal-length
 * buffers, which is always true for SHA-256 hex digests.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Lightweight E.164 sanity check. We do NOT do a full carrier-format validation
 * (that's Twilio's job at send time) — we just reject the obviously-wrong
 * inputs the form might send (empty, missing leading +, non-digit body).
 *
 * Examples that pass: "+15555550123", "+442012345678".
 * Examples that fail: "555-555-0123", "+", "+abc".
 */
export function isPlausibleE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}
