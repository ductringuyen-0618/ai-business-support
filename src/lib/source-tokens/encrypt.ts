/**
 * App-level AES-256-GCM encryption for Source OAuth tokens.
 *
 * The `source_connections` table stores `oauth_access_token` and
 * `oauth_refresh_token` as `text`, but never plaintext — every value passed
 * through to the DB is first run through `encryptToken`, and every value read
 * back is run through `decryptToken`.
 *
 * Why AES at the app layer and not `pgcrypto`?
 *  - Rotating an app env var (`SOURCE_TOKEN_ENCRYPTION_KEY`) is one line.
 *    Rotating a `pgcrypto` key on Neon involves an extension reload, no
 *    versioned key concept, and couples our key management to the DB.
 *  - Ciphertexts carry a `v1:` prefix (see `CIPHERTEXT_PREFIX`). When we
 *    rotate keys we ship `v2:` ciphertexts alongside; readers try the new key
 *    first, then fall back to the old. No DB migration required.
 *
 * Format on the wire (all base64-encoded, joined by `:`):
 *   v1:<iv_b64>:<auth_tag_b64>:<ciphertext_b64>
 *
 * IV is 12 bytes (GCM recommended); auth tag is 16 bytes (Node's default).
 *
 * The key is 32 bytes of entropy, base64-encoded in env. Generate with:
 *   node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32; // AES-256
const IV_LENGTH_BYTES = 12; // GCM standard
const CIPHERTEXT_PREFIX = "v1";

let _cachedKey: Buffer | undefined;

function getEncryptionKey(): Buffer {
  if (_cachedKey) return _cachedKey;
  const raw = process.env.SOURCE_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "SOURCE_TOKEN_ENCRYPTION_KEY is not set. Generate one with " +
        '`node -e \'console.log(require("crypto").randomBytes(32).toString("base64"))\'` ' +
        "and add it to .env.local.",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `SOURCE_TOKEN_ENCRYPTION_KEY must decode to ${KEY_LENGTH_BYTES} bytes (got ${buf.length}). ` +
        "It must be 32 random bytes, base64-encoded.",
    );
  }
  _cachedKey = buf;
  return buf;
}

/**
 * Test/CI escape hatch: reset the in-memory cached key so a test can swap
 * `process.env.SOURCE_TOKEN_ENCRYPTION_KEY` mid-suite. Not exported from the
 * package's public surface — only `__tests__` should reach for this.
 */
export function __resetEncryptionKeyCacheForTests(): void {
  _cachedKey = undefined;
}

/**
 * Encrypt a token. Returns a self-contained string suitable for round-tripping
 * through Postgres `text`. Never logs the plaintext or the ciphertext.
 */
export function encryptToken(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new TypeError("encryptToken: plaintext must be a string");
  }
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    CIPHERTEXT_PREFIX,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a token produced by `encryptToken`. Throws if the prefix is unknown
 * or the auth tag does not verify (tamper detection).
 */
export function decryptToken(ciphertextString: string): string {
  if (typeof ciphertextString !== "string") {
    throw new TypeError("decryptToken: ciphertext must be a string");
  }
  const parts = ciphertextString.split(":");
  if (parts.length !== 4) {
    throw new Error("decryptToken: malformed ciphertext (expected 4 colon-separated parts)");
  }
  const [version, ivB64, tagB64, dataB64] = parts;
  if (version !== CIPHERTEXT_PREFIX) {
    throw new Error(`decryptToken: unknown ciphertext version "${version}"`);
  }
  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
