/**
 * Classifier — the single LLM call per Review (ADR-0004).
 *
 * Contract:
 *   - Input text MUST already be redacted by the upstream `Redactor` (ADR-0006).
 *     This module trusts its caller; it does not double-redact.
 *   - Exactly one Anthropic message is sent per call, with prompt caching on
 *     the stable system block. On a Zod validation failure we retry ONCE with a
 *     stricter framing; if that also fails we throw and the calling
 *     `ingest_review` job (slice 9) retries the whole thing with backoff.
 *
 * Public surface is the `classify()` function and the `Classification` /
 * `ClassifierInput` types re-exported from `./schema`.
 */
import {
  type AnthropicCreateParams,
  type AnthropicCreateResponse,
  type AnthropicMessageClient,
  getDefaultClient,
  resolveModel,
} from "./anthropic-client";
import { PROMPT_VERSION, RETRY_INSTRUCTION, SYSTEM_PROMPT, buildUserMessage } from "./prompts/v1";
import { type Classification, type ClassifierInput, classificationSchema } from "./schema";

export { classificationSchema, type Classification, type ClassifierInput } from "./schema";
export {
  THEMES,
  SENTIMENTS,
  SEVERITIES,
  type Theme,
  type Sentiment,
  type Severity,
} from "./schema";
export { PROMPT_VERSION } from "./prompts/v1";

/** Internal cap. Output is small JSON; 1024 is comfortable for any v1 case. */
const MAX_TOKENS = 1024;

/**
 * Optional dependency-injection seam. Tests pass a stub `client`; production
 * leaves it out and gets the lazily-constructed SDK client.
 */
export interface ClassifyOptions {
  client?: AnthropicMessageClient;
  model?: string;
}

/**
 * Run the v1 Classifier prompt against the given Review and return a validated
 * Classification. See module docstring for the retry contract.
 */
export async function classify(
  input: ClassifierInput,
  options: ClassifyOptions = {},
): Promise<Classification> {
  const client = options.client ?? getDefaultClient();
  const model = options.model ?? resolveModel();

  const baseUserMessage = buildUserMessage(input);

  // First attempt.
  const firstRaw = await callAnthropic(client, model, baseUserMessage);
  const firstParsed = tryParseClassification(firstRaw);
  if (firstParsed.ok) return firstParsed.value;

  // Single retry with stricter framing. We append the retry instruction to the
  // user message; the cached system block is unchanged so the cache hit holds.
  const retryUserMessage = `${baseUserMessage}\n\n${RETRY_INSTRUCTION}`;
  const secondRaw = await callAnthropic(client, model, retryUserMessage);
  const secondParsed = tryParseClassification(secondRaw);
  if (secondParsed.ok) return secondParsed.value;

  throw new ClassifierValidationError("Classifier produced invalid output twice in a row", {
    firstAttempt: firstParsed.error,
    secondAttempt: secondParsed.error,
    lastRawText: secondRaw,
  });
}

/**
 * Thrown when both the initial attempt and the single retry fail Zod
 * validation. The `ingest_review` job catches this and schedules a retry with
 * backoff (slice 9). We attach the most recent raw LLM text so the failure is
 * debuggable from the job's error column without re-running the call.
 */
export class ClassifierValidationError extends Error {
  readonly firstAttempt: string;
  readonly secondAttempt: string;
  readonly lastRawText: string;
  constructor(
    message: string,
    details: { firstAttempt: string; secondAttempt: string; lastRawText: string },
  ) {
    super(message);
    this.name = "ClassifierValidationError";
    this.firstAttempt = details.firstAttempt;
    this.secondAttempt = details.secondAttempt;
    this.lastRawText = details.lastRawText;
  }
}

async function callAnthropic(
  client: AnthropicMessageClient,
  model: string,
  userMessage: string,
): Promise<string> {
  const params: AnthropicCreateParams = {
    model,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Mark the stable block for prompt caching. The dynamic user message
        // is uncached. Anthropic charges the first request at write-cost and
        // subsequent requests within the cache TTL at read-cost.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  };

  const response = await client.create(params);
  return extractText(response);
}

function extractText(response: AnthropicCreateResponse): string {
  return response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

type ParseResult = { ok: true; value: Classification } | { ok: false; error: string };

/**
 * Pull JSON out of `<output>...</output>` (preferred), or fall back to the
 * first `{...}` block if the LLM forgot the tags. Then validate via Zod and
 * attach `prompt_version`.
 *
 * Returning a discriminated union (rather than throwing) keeps the retry path
 * branch-free in `classify()`.
 */
function tryParseClassification(rawText: string): ParseResult {
  const json = extractJsonPayload(rawText);
  if (json === null) {
    return { ok: false, error: "no JSON payload found in LLM response" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      error: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The LLM is told NOT to emit prompt_version; we attach it before validation
  // so the resulting object is the persisted shape end-to-end.
  const withVersion =
    typeof parsedJson === "object" && parsedJson !== null
      ? { ...(parsedJson as Record<string, unknown>), prompt_version: PROMPT_VERSION }
      : parsedJson;

  const result = classificationSchema.safeParse(withVersion);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  // Dedupe themes defensively — the LLM occasionally repeats a tag. Order is
  // preserved.
  const dedupedThemes = Array.from(new Set(result.data.themes));
  return { ok: true, value: { ...result.data, themes: dedupedThemes } };
}

/**
 * Pull the JSON payload out of an LLM response, tolerating reasonable
 * variations:
 *   1. `<output>{...}</output>` — the format we ask for.
 *   2. A bare `{...}` — fallback when the LLM drops the tags.
 *   3. ```json fenced ``` — fallback for markdown-happy responses.
 */
function extractJsonPayload(rawText: string): string | null {
  const outputMatch = rawText.match(/<output>([\s\S]*?)<\/output>/i);
  if (outputMatch) return outputMatch[1].trim();

  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();

  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return rawText.slice(firstBrace, lastBrace + 1).trim();
  }

  return null;
}
