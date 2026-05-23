/**
 * Thin wrapper around the Resend SDK so the Email Channel (slice 11) can be
 * unit-tested without hitting the network.
 *
 * Tests inject a stub `ResendEmailClient` via `sendEmail(input, { client })`;
 * production code calls `getDefaultClient()` which lazily constructs an SDK
 * instance keyed on `RESEND_API_KEY`. Mirrors the Classifier's
 * `AnthropicMessageClient` DI seam (`src/lib/classifier/anthropic-client.ts`)
 * so the two channels feel the same to wire.
 *
 * The `from` default is derived from `APP_BASE_URL` (`notifications@<host>`)
 * so a single env var controls the visible sender across environments. Set
 * a `from` override per-call if you need a different sender (e.g. the digest
 * job in a later slice may want `digest@<host>`).
 *
 * Slice 10 (running in parallel) needs Resend too; per the coordination notes
 * on issue #12 they have an inline call in `src/lib/email/backfill-ready.ts`
 * which the slice author will consolidate against this wrapper at rebase
 * time. Keep this module self-contained so that consolidation is mechanical.
 */
import { Resend } from "resend";

export interface SendEmailInput {
  to: string[];
  subject: string;
  html: string;
  /** Override the `from` address. Defaults to `notifications@<APP_BASE_URL host>`. */
  from?: string;
}

/**
 * Minimum surface we need from the SDK. Keeping this tight lets tests pass a
 * one-line stub instead of mocking the full SDK type.
 */
export interface ResendEmailClient {
  send(params: { from: string; to: string[]; subject: string; html: string }): Promise<void>;
}

export interface SendEmailOptions {
  client?: ResendEmailClient;
}

class SdkClient implements ResendEmailClient {
  private readonly sdk: Resend;

  constructor(apiKey: string) {
    this.sdk = new Resend(apiKey);
  }

  async send(params: { from: string; to: string[]; subject: string; html: string }): Promise<void> {
    // The Resend SDK returns `{ data, error }` rather than throwing on 4xx;
    // we normalise to throwing here so the `deliver_escalation` handler can
    // treat all failures uniformly (pg-boss retries on throw).
    const result = await this.sdk.emails.send({
      from: params.from,
      to: params.to,
      subject: params.subject,
      html: params.html,
    });
    if (result.error) {
      throw new Error(`Resend send failed: ${result.error.message ?? "unknown"}`);
    }
  }
}

let cachedDefault: ResendEmailClient | null = null;

/**
 * Lazily build (and memoise) the production SDK client. We resolve env vars
 * at call time so tests that set them per-case still work.
 *
 * E2E hook: when `E2E_TEST_MODE=1` we short-circuit to an in-process mock
 * (`src/lib/test-mode/resend-mock.ts`) that records the call payload via
 * `src/lib/test-mode/recorder.ts` so the spec can assert on it.
 */
export function getDefaultClient(): ResendEmailClient {
  if (cachedDefault) return cachedDefault;
  if (process.env.E2E_TEST_MODE === "1") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mockMod =
      require("@/lib/test-mode/resend-mock") as typeof import("@/lib/test-mode/resend-mock");
    cachedDefault = mockMod.createE2EResendMock();
    return cachedDefault;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set — the Email channel cannot reach Resend. " +
        "Set it in .env.local for local dev or pass a stub client to sendEmail() in tests.",
    );
  }
  cachedDefault = new SdkClient(apiKey);
  return cachedDefault;
}

/** Test-only: drop the memoised client so the next call rebuilds it. */
export function _resetDefaultClientForTests(): void {
  cachedDefault = null;
}

/**
 * Default sender derived from `APP_BASE_URL`. Falling back to a literal so the
 * worker boots in CI even when `APP_BASE_URL` is unset (the test stub never
 * looks at this value anyway).
 */
export function defaultFromAddress(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) return "notifications@example.com";
  try {
    const url = new URL(base);
    return `notifications@${url.hostname}`;
  } catch {
    return "notifications@example.com";
  }
}

/**
 * Send an Email through the Channel wrapper.
 *
 * `to` is an array so the caller can address a Distribution (multiple
 * Operators sharing an inbox). The `fire_incident -> deliver_escalation`
 * pipeline always passes exactly one address — the per-Operator-Email-pref
 * route emits one Delivery per Operator — but keeping the param plural here
 * means a future "team inbox" feature is a one-line change at the call site.
 */
export async function sendEmail(
  input: SendEmailInput,
  options: SendEmailOptions = {},
): Promise<void> {
  if (input.to.length === 0) {
    throw new Error("sendEmail: `to` must contain at least one address");
  }
  const client = options.client ?? getDefaultClient();
  const from = input.from ?? defaultFromAddress();
  await client.send({
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
  });
}
