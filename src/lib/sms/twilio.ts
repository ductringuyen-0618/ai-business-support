/**
 * Thin wrapper around the Twilio SDK so the SMS Channel (slice 11) can be
 * unit-tested without hitting the network.
 *
 * Tests inject a stub `TwilioSmsClient` via `sendSms(input, { client })`;
 * production code calls `getDefaultClient()` which lazily constructs an SDK
 * instance keyed on `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
 * `TWILIO_FROM_NUMBER`. Mirrors the Resend wrapper next door so the two
 * channels feel the same to wire.
 *
 * Twilio's official SDK is `twilio` on npm. We pin to its `messages.create()`
 * surface only — the deliverability hooks (status callbacks, etc.) are
 * deferred to a later slice.
 */
import twilio from "twilio";

export interface SendSmsInput {
  to: string;
  body: string;
}

/**
 * Minimum surface we need from the SDK. Keeping this tight lets tests pass a
 * one-line stub instead of mocking the full SDK type.
 */
export interface TwilioSmsClient {
  send(params: { from: string; to: string; body: string }): Promise<void>;
}

export interface SendSmsOptions {
  client?: TwilioSmsClient;
}

class SdkClient implements TwilioSmsClient {
  private readonly sdk: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string) {
    this.sdk = twilio(accountSid, authToken);
  }

  async send(params: { from: string; to: string; body: string }): Promise<void> {
    await this.sdk.messages.create({
      from: params.from,
      to: params.to,
      body: params.body,
    });
  }
}

interface CachedDefault {
  client: TwilioSmsClient;
  from: string;
}

let cachedDefault: CachedDefault | null = null;

/**
 * Lazily build (and memoise) the production SDK client. We resolve env vars
 * at call time so tests that set them per-case still work.
 *
 * Bundles the `from` number alongside the client because Twilio requires a
 * sender per message and the env-var is the only place it lives.
 */
export function getDefaultClient(): CachedDefault {
  if (cachedDefault) return cachedDefault;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    throw new Error(
      "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER must all be set — " +
        "the SMS channel cannot reach Twilio. Pass a stub client to sendSms() in tests.",
    );
  }
  cachedDefault = { client: new SdkClient(sid, token), from };
  return cachedDefault;
}

/** Test-only: drop the memoised client so the next call rebuilds it. */
export function _resetDefaultClientForTests(): void {
  cachedDefault = null;
}

/**
 * Send an SMS through the Channel wrapper.
 *
 * Caller is responsible for keeping `body` short enough to fit the desired
 * segment count — Twilio will happily multi-part long messages but the
 * Escalation pipeline targets ≤320 chars (≤2 segments).
 */
export async function sendSms(input: SendSmsInput, options: SendSmsOptions = {}): Promise<void> {
  if (options.client) {
    // When a stub is injected the caller's stub controls the `from`.
    await options.client.send({ from: "stub-from", to: input.to, body: input.body });
    return;
  }
  const def = getDefaultClient();
  await def.client.send({ from: def.from, to: input.to, body: input.body });
}
