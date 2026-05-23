/**
 * Unit tests for the Classifier.
 *
 * Strategy: the Anthropic SDK is mocked at the `AnthropicMessageClient`
 * boundary defined in `anthropic-client.ts`. Every test injects a stub that
 * returns a pre-recorded JSON fixture (see `__fixtures__/anthropic/`). This
 * keeps the unit tests hermetic — no network, no API key — while still
 * exercising the real prompt-build, JSON extraction, Zod validation, retry,
 * and `prompt_version` attach paths.
 *
 * Coverage required by issue #5:
 *   - clearly-positive 5-star
 *   - mildly-negative 2-star
 *   - 4-star slur (Incident despite high stars — ADR-0002)
 *   - food-safety mention
 *   - ambulance / medical emergency
 *   - sarcasm
 *   - non-English Review
 * Plus retry-on-invalid and throw-after-two-failures paths to lock the
 * documented retry contract from the issue.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ClassifierValidationError, PROMPT_VERSION, classify } from "../index";
import type {
  AnthropicCreateParams,
  AnthropicCreateResponse,
  AnthropicMessageClient,
} from "../anthropic-client";
import type { ClassifierInput } from "../schema";

const FIXTURE_DIR = join(__dirname, "..", "__fixtures__", "anthropic");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

/**
 * Build a stub Anthropic client that returns a sequence of recorded responses
 * (one per call). The returned object also exposes the captured request
 * params, so tests can assert on prompt caching / model / system prompt
 * stability without coupling to internals.
 */
function makeStub(responses: AnthropicCreateResponse[]) {
  const calls: AnthropicCreateParams[] = [];
  let i = 0;
  const client: AnthropicMessageClient = {
    create: vi.fn(async (params: AnthropicCreateParams) => {
      calls.push(params);
      const r = responses[i++];
      if (!r) throw new Error(`stub ran out of responses after ${calls.length} calls`);
      return r;
    }),
  };
  return { client, calls };
}

const SAMPLE_INPUT: ClassifierInput = {
  redactedText: "Loved the service from [REVIEWER] — pastries were amazing.",
  starRating: 5,
  postedAt: new Date("2026-05-20T14:00:00Z"),
  businessProfile: { name: "Acme Bakery", industry: "food_service" },
};

describe("classify() — required scenarios from issue #5", () => {
  it("classifies a clearly-positive 5-star Review as non-incident with positive sentiment", async () => {
    const { client } = makeStub([loadFixture("positive-5-star.json")]);
    const result = await classify(
      {
        redactedText: "Best bakery in town! The staff are friendly and the pastries are perfect.",
        starRating: 5,
        postedAt: "2026-05-20T14:00:00Z",
        businessProfile: { name: "Acme Bakery", industry: "food_service" },
      },
      { client },
    );

    expect(result.is_incident).toBe(false);
    expect(result.severity).toBeNull();
    expect(result.sentiment).toBe("positive");
    expect(result.themes.length).toBeGreaterThan(0);
    expect(result.prompt_version).toBe(PROMPT_VERSION);
  });

  it("classifies a mildly-negative 2-star Review as non-incident with negative sentiment and wait-time theme", async () => {
    const { client } = makeStub([loadFixture("mild-negative-2-star.json")]);
    const result = await classify(
      {
        redactedText: "Waited 25 minutes for a sandwich. Food was fine but the wait was rough.",
        starRating: 2,
        postedAt: "2026-05-20T12:30:00Z",
        businessProfile: { name: "Acme Bakery", industry: "food_service" },
      },
      { client },
    );

    expect(result.is_incident).toBe(false);
    expect(result.severity).toBeNull();
    expect(result.sentiment).toBe("negative");
    expect(result.themes).toContain("wait_time");
  });

  it("flags a 4-star Review containing a slur as an Incident (ADR-0002: content, not stars)", async () => {
    const { client } = makeStub([loadFixture("four-star-slur.json")]);
    const result = await classify(
      {
        redactedText:
          "Food was good overall but one of the staff used a racial slur at the table next to ours. 4 stars only because the food itself was fine.",
        starRating: 4,
        postedAt: "2026-05-20T19:00:00Z",
        businessProfile: { name: "Acme Bakery", industry: "food_service" },
      },
      { client },
    );

    expect(result.is_incident).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.themes).toContain("staff_attitude");
  });

  it("flags a food-safety Review as a high-severity Incident", async () => {
    const { client } = makeStub([loadFixture("food-safety.json")]);
    const result = await classify(
      {
        redactedText:
          "I got severe food poisoning after eating here — was vomiting all night. There was a hair in my soup too.",
        starRating: 1,
        postedAt: "2026-05-20T22:15:00Z",
        businessProfile: { name: "Acme Bakery", industry: "food_service" },
      },
      { client },
    );

    expect(result.is_incident).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.themes).toEqual(expect.arrayContaining(["cleanliness", "product_quality"]));
  });

  it("flags an ambulance / medical-emergency Review as a high-severity Incident", async () => {
    const { client } = makeStub([loadFixture("ambulance.json")]);
    const result = await classify(
      {
        redactedText:
          "An elderly customer collapsed in the cafe and the staff did nothing — we had to call an ambulance ourselves. The manager refused to help.",
        starRating: 1,
        postedAt: "2026-05-20T16:45:00Z",
        businessProfile: { name: "Acme Bakery", industry: "food_service" },
      },
      { client },
    );

    expect(result.is_incident).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.themes.length).toBeGreaterThan(0);
  });

  it("classifies sarcasm by literal sentiment, not surface words", async () => {
    const { client } = makeStub([loadFixture("sarcasm.json")]);
    const result = await classify(
      {
        redactedText:
          "Oh wonderful, another 45 minutes for a coffee! Truly a delightful experience as always.",
        starRating: 2,
        postedAt: "2026-05-20T08:00:00Z",
        businessProfile: { name: "Acme Bakery", industry: "food_service" },
      },
      { client },
    );

    expect(result.sentiment).toBe("negative");
    expect(result.themes).toContain("wait_time");
  });

  it("classifies a non-English (Spanish) Review without refusing", async () => {
    const { client } = makeStub([loadFixture("non-english-spanish.json")]);
    const result = await classify(
      {
        redactedText:
          "¡Qué experiencia tan maravillosa! La comida estaba deliciosa y el personal fue muy amable.",
        starRating: 5,
        postedAt: "2026-05-20T20:00:00Z",
        businessProfile: { name: "Acme Bakery", industry: "food_service" },
      },
      { client },
    );

    expect(result.sentiment).toBe("positive");
    expect(result.suggested_reply.length).toBeGreaterThan(0);
    expect(result.is_incident).toBe(false);
  });
});

describe("classify() — request shape", () => {
  it("uses prompt caching on the system block and includes the user message", async () => {
    const { client, calls } = makeStub([loadFixture("positive-5-star.json")]);
    await classify(SAMPLE_INPUT, { client });

    expect(calls).toHaveLength(1);
    const params = calls[0];

    // The stable system block carries cache_control: ephemeral.
    expect(params.system).toHaveLength(1);
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.system[0].text).toMatch(/Classifier/);

    // The dynamic user message is uncached and includes the Business name + stars.
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe("user");
    expect(params.messages[0].content).toContain("Acme Bakery");
    expect(params.messages[0].content).toContain("5/5");
    expect(params.messages[0].content).toContain("[REVIEWER]");
  });

  it("honours an explicit model override via options", async () => {
    const { client, calls } = makeStub([loadFixture("positive-5-star.json")]);
    await classify(SAMPLE_INPUT, { client, model: "claude-opus-4-7" });
    expect(calls[0].model).toBe("claude-opus-4-7");
  });

  it("defaults the model to claude-sonnet-4-6 (the documented default)", async () => {
    const { client, calls } = makeStub([loadFixture("positive-5-star.json")]);
    const prev = process.env.CLASSIFIER_MODEL;
    delete process.env.CLASSIFIER_MODEL;
    try {
      await classify(SAMPLE_INPUT, { client });
      expect(calls[0].model).toBe("claude-sonnet-4-6");
    } finally {
      if (prev !== undefined) process.env.CLASSIFIER_MODEL = prev;
    }
  });

  it("attaches prompt_version to every successful Classification", async () => {
    const { client } = makeStub([loadFixture("positive-5-star.json")]);
    const result = await classify(SAMPLE_INPUT, { client });
    expect(result.prompt_version).toBe(PROMPT_VERSION);
  });
});

describe("classify() — retry contract", () => {
  it("retries once with stricter framing when the first response fails validation", async () => {
    const fx = loadFixture<{ first: AnthropicCreateResponse; second: AnthropicCreateResponse }>(
      "invalid-then-valid.json",
    );
    const { client, calls } = makeStub([fx.first, fx.second]);

    const result = await classify(SAMPLE_INPUT, { client });

    expect(calls).toHaveLength(2);
    // First call uses the base user message; second appends the retry instruction.
    expect(calls[0].messages[0].content).not.toMatch(/NOT VALID JSON/);
    expect(calls[1].messages[0].content).toMatch(/NOT VALID JSON/);
    // System block (and thus the cache key) is unchanged between attempts.
    expect(calls[1].system[0].text).toBe(calls[0].system[0].text);

    expect(result.is_incident).toBe(false);
    expect(result.themes).toContain("wait_time");
  });

  it("throws ClassifierValidationError when both attempts fail validation", async () => {
    const fx = loadFixture<{ first: AnthropicCreateResponse; second: AnthropicCreateResponse }>(
      "invalid-twice.json",
    );
    const { client, calls } = makeStub([fx.first, fx.second]);

    await expect(classify(SAMPLE_INPUT, { client })).rejects.toBeInstanceOf(
      ClassifierValidationError,
    );
    expect(calls).toHaveLength(2);
  });

  it("does not retry a third time even if the second attempt is also invalid", async () => {
    const fx = loadFixture<{ first: AnthropicCreateResponse; second: AnthropicCreateResponse }>(
      "invalid-twice.json",
    );
    const { client, calls } = makeStub([fx.first, fx.second]);
    await classify(SAMPLE_INPUT, { client }).catch(() => undefined);
    expect(calls).toHaveLength(2);
  });
});
