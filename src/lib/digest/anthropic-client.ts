/**
 * Thin wrapper around the Anthropic SDK for the Digest composer.
 *
 * Mirrors `src/lib/classifier/anthropic-client.ts` — same DI seam shape so the
 * two LLM modules feel the same to wire and test. Production code calls
 * `getDefaultDigestClient()`; tests inject a stub via `composeDigest(..., { client })`.
 *
 * Lives in its own file rather than reusing the Classifier client so that
 * `DIGEST_COMPOSER_MODEL` (Digest-specific override) is separate from the
 * Classifier's `CLASSIFIER_MODEL` env var. The two modules can run on
 * different models if we ever need to tune Digest output quality without
 * touching the Classifier's behaviour.
 */
import Anthropic from "@anthropic-ai/sdk";

import type {
  AnthropicCreateParams,
  AnthropicCreateResponse,
  AnthropicMessageClient,
} from "../classifier/anthropic-client";

export type { AnthropicCreateParams, AnthropicCreateResponse, AnthropicMessageClient };

export const DEFAULT_DIGEST_MODEL = "claude-sonnet-4-6";

class SdkClient implements AnthropicMessageClient {
  private readonly sdk: Anthropic;

  constructor(apiKey: string) {
    this.sdk = new Anthropic({ apiKey });
  }

  async create(params: AnthropicCreateParams): Promise<AnthropicCreateResponse> {
    const raw = (await this.sdk.messages.create(
      params as unknown as Parameters<typeof this.sdk.messages.create>[0],
    )) as unknown as AnthropicCreateResponse;
    return raw;
  }
}

let cachedDefault: AnthropicMessageClient | null = null;

export function getDefaultDigestClient(): AnthropicMessageClient {
  if (cachedDefault) return cachedDefault;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — the Digest composer cannot reach Anthropic. " +
        "Set it in .env.local for local dev or pass a stub client to composeDigest() in tests.",
    );
  }
  cachedDefault = new SdkClient(apiKey);
  return cachedDefault;
}

export function _resetDefaultDigestClientForTests(): void {
  cachedDefault = null;
}

export function resolveDigestModel(): string {
  return process.env.DIGEST_COMPOSER_MODEL?.trim() || DEFAULT_DIGEST_MODEL;
}
