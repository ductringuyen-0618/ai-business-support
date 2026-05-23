/**
 * Thin wrapper around the Anthropic SDK so the Classifier can be unit-tested
 * without hitting the network.
 *
 * Tests inject a stub `AnthropicMessageClient` via `classify(input, { client })`;
 * production code calls `getDefaultClient()` which lazily constructs an SDK
 * instance keyed on `ANTHROPIC_API_KEY` and `CLASSIFIER_MODEL` (defaulting to
 * Sonnet 4.6 per the slice's defensible-choice guidance).
 */
import Anthropic from "@anthropic-ai/sdk";

/**
 * Minimum surface we need from the SDK. Keeping this interface tight makes
 * tests trivial — a stub returning a recorded fixture is a few lines.
 */
export interface AnthropicMessageClient {
  create(params: AnthropicCreateParams): Promise<AnthropicCreateResponse>;
}

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  system: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
  }>;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

/**
 * A trimmed-down response shape — we only read text content blocks. The full
 * SDK type includes usage stats etc. that the Classifier doesn't need.
 */
export interface AnthropicCreateResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export const DEFAULT_CLASSIFIER_MODEL = "claude-sonnet-4-6";

/**
 * Wraps the official SDK in the minimal interface. Anthropic's SDK types are
 * generic over content-block kinds; we narrow to what we use.
 */
class SdkClient implements AnthropicMessageClient {
  private readonly sdk: Anthropic;

  constructor(apiKey: string) {
    this.sdk = new Anthropic({ apiKey });
  }

  async create(params: AnthropicCreateParams): Promise<AnthropicCreateResponse> {
    // The SDK accepts the same `system` block-array shape with `cache_control`.
    // We cast through `unknown` because the SDK's discriminated unions are
    // wider than our trimmed interface.
    const raw = (await this.sdk.messages.create(
      params as unknown as Parameters<typeof this.sdk.messages.create>[0],
    )) as unknown as AnthropicCreateResponse;
    return raw;
  }
}

let cachedDefault: AnthropicMessageClient | null = null;

/**
 * Lazily build (and memoise) the production SDK client. We resolve env vars at
 * call time so tests that set them per-case still work.
 */
export function getDefaultClient(): AnthropicMessageClient {
  if (cachedDefault) return cachedDefault;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — the Classifier cannot reach Anthropic. " +
        "Set it in .env.local for local dev or pass a stub client to classify() in tests.",
    );
  }
  cachedDefault = new SdkClient(apiKey);
  return cachedDefault;
}

/** Test-only: drop the memoised client so the next call rebuilds it. */
export function _resetDefaultClientForTests(): void {
  cachedDefault = null;
}

/** Resolve the model id from env, falling back to the documented default. */
export function resolveModel(): string {
  return process.env.CLASSIFIER_MODEL?.trim() || DEFAULT_CLASSIFIER_MODEL;
}
