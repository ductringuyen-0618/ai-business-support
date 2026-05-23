/**
 * Unit tests for the DigestComposer.
 *
 * Strategy mirrors the Classifier tests: load recorded fixture JSON files, pass
 * a stub `AnthropicMessageClient` to `composeDigest`, assert on the structural
 * shape of the returned DigestBody.
 *
 * Coverage required by issue #16:
 *   - High-volume mixed week — structural shape, exactly 3 Patterns, no
 *     hallucinated ids, evidence quotes all sourced from input.
 *   - All-positive week — `overallTone === "celebrate"` AND all 3 Patterns
 *     are reinforcement-kind from the Playbook.
 *   - All-negative week — `overallTone === "concerning"` AND Patterns are
 *     remediation-kind.
 *   - Industry-misfit — barbershop Business; restaurant-only vertical
 *     Patterns must NOT appear in the LLM input.
 *   - Retry-on-Zod-failure — first response has a hallucinated patternId; the
 *     composer retries and succeeds with a known-good fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  AnthropicCreateParams,
  AnthropicCreateResponse,
  AnthropicMessageClient,
} from "../anthropic-client";
import { composeDigest, type ClassifiedReview } from "../composer";
import { PLAYBOOK, type Theme } from "../playbook";

const FIXTURE_DIR = join(__dirname, "..", "__fixtures__", "anthropic");

function loadFixture(name: string): AnthropicCreateResponse {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"),
  ) as AnthropicCreateResponse;
}

function makeClient(responses: AnthropicCreateResponse[]): {
  client: AnthropicMessageClient;
  calls: AnthropicCreateParams[];
} {
  const queue = [...responses];
  const calls: AnthropicCreateParams[] = [];
  const client: AnthropicMessageClient = {
    create: async (params) => {
      calls.push(params);
      const next = queue.shift();
      if (!next) throw new Error("client: no more responses queued");
      return next;
    },
  };
  return { client, calls };
}

function makeReview(overrides: Partial<ClassifiedReview> = {}): ClassifiedReview {
  return {
    id: "rev-default",
    starRating: 4,
    redactedText: "A neutral review.",
    postedAt: new Date("2026-05-19T10:00:00Z"),
    themes: ["service"] as Theme[],
    sentiment: "neutral",
    ...overrides,
  };
}

const NOW = new Date("2026-05-25T08:00:00Z");

describe("composeDigest — high-volume mixed week", () => {
  it("returns exactly 3 Patterns, all from the candidate set, structural shape intact", async () => {
    const reviews: ClassifiedReview[] = [
      makeReview({
        id: "r-wait-1",
        starRating: 2,
        redactedText: "Waited 25 minutes for a sandwich at lunch on Friday.",
        themes: ["wait_time"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-wait-2",
        starRating: 3,
        redactedText: "Long queue at the till around midday — fewer staff than usual.",
        themes: ["wait_time", "service"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-service-1",
        starRating: 1,
        redactedText: "[REVIEWER] was ignored at the counter for ten minutes.",
        themes: ["service"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-quality-1",
        starRating: 2,
        redactedText: "The pastries were stale on Tuesday morning.",
        themes: ["product_quality"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-mixed-1",
        starRating: 4,
        redactedText: "Mostly good, slight slow service.",
        themes: ["service"],
        sentiment: "neutral",
      }),
    ];

    const { client, calls } = makeClient([loadFixture("high-volume-mixed")]);
    const result = await composeDigest(
      {
        reviews,
        business: { id: "biz-1", name: "Acme Cafe", industry: "cafe" },
        playbook: PLAYBOOK,
        weekOverWeekTheme: {
          service: { current: 3, previous: 1 },
          wait_time: { current: 4, previous: 1 },
          product_quality: { current: 1, previous: 2 },
        },
        now: NOW,
      },
      { client },
    );

    expect(calls).toHaveLength(1);
    // Verify prompt caching is wired.
    expect(calls[0].system[0].cache_control).toEqual({ type: "ephemeral" });

    expect(result.topPatterns).toHaveLength(3);
    expect(result.overallTone).toBe("concerning");

    const playbookIds = new Set(PLAYBOOK.map((p) => p.id));
    for (const p of result.topPatterns) {
      expect(playbookIds.has(p.patternId)).toBe(true);
      expect(p.evidence.length).toBeGreaterThan(0);
      for (const e of p.evidence) {
        // Every evidence quote must come from the input reviews.
        expect(reviews.some((r) => r.redactedText === e.redactedQuote)).toBe(true);
      }
    }

    // themeMovement carries integer deltas with valid directions.
    expect(result.themeMovement.length).toBeGreaterThan(0);
    for (const m of result.themeMovement) {
      expect(["up", "down", "flat"]).toContain(m.direction);
      expect(Number.isInteger(m.delta)).toBe(true);
    }
  });
});

describe("composeDigest — all-positive week", () => {
  it("returns celebrate tone with all 3 Patterns from the reinforcement set", async () => {
    const reviews: ClassifiedReview[] = [
      makeReview({
        id: "r-pos-1",
        starRating: 5,
        redactedText: "The team are wonderful — [REVIEWER] always remembers my order.",
        themes: ["service", "staff_attitude"],
        sentiment: "positive",
      }),
      makeReview({
        id: "r-pos-2",
        starRating: 5,
        redactedText:
          "Best bakery in town. Pastries are perfect and the morning team is brilliant.",
        themes: ["product_quality", "service"],
        sentiment: "positive",
      }),
      makeReview({
        id: "r-pos-3",
        starRating: 5,
        redactedText: "Saturday morning visit was perfect — quick service and great coffee.",
        themes: ["service", "wait_time"],
        sentiment: "positive",
      }),
      makeReview({
        id: "r-pos-4",
        starRating: 5,
        redactedText: "Lovely shop, lovely team.",
        themes: ["service"],
        sentiment: "positive",
      }),
    ];

    const { client } = makeClient([loadFixture("all-positive")]);
    const result = await composeDigest(
      {
        reviews,
        business: { id: "biz-1", name: "Acme Bakery", industry: "cafe" },
        playbook: PLAYBOOK,
        weekOverWeekTheme: {
          service: { current: 4, previous: 1 },
          product_quality: { current: 2, previous: 0 },
        },
        now: NOW,
      },
      { client },
    );

    expect(result.overallTone).toBe("celebrate");
    expect(result.topPatterns).toHaveLength(3);

    const reinforcementIds = new Set(
      PLAYBOOK.filter((p) => p.kind === "reinforcement").map((p) => p.id),
    );
    for (const p of result.topPatterns) {
      expect(reinforcementIds.has(p.patternId)).toBe(true);
    }
  });
});

describe("composeDigest — all-negative week", () => {
  it("returns concerning tone with Patterns drawn from the remediation set", async () => {
    const reviews: ClassifiedReview[] = [
      makeReview({
        id: "r-neg-1",
        starRating: 1,
        redactedText:
          "Restrooms were filthy on Saturday evening — clearly hadn't been cleaned in hours.",
        themes: ["cleanliness"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-neg-2",
        starRating: 1,
        redactedText: "The bartender was rude and dismissive when I asked for a substitution.",
        themes: ["staff_attitude"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-neg-3",
        starRating: 1,
        redactedText: "Worst service experience of my year — nobody acknowledged us.",
        themes: ["service"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-neg-4",
        starRating: 2,
        redactedText: "Filthy floors throughout.",
        themes: ["cleanliness"],
        sentiment: "negative",
      }),
    ];

    const { client } = makeClient([loadFixture("all-negative")]);
    const result = await composeDigest(
      {
        reviews,
        business: { id: "biz-1", name: "Acme Bar", industry: "restaurant" },
        playbook: PLAYBOOK,
        weekOverWeekTheme: {
          cleanliness: { current: 2, previous: 0 },
          staff_attitude: { current: 1, previous: 0 },
          service: { current: 3, previous: 0 },
        },
        now: NOW,
      },
      { client },
    );

    expect(result.overallTone).toBe("concerning");

    const remediationIds = new Set(
      PLAYBOOK.filter((p) => p.kind === "remediation").map((p) => p.id),
    );
    for (const p of result.topPatterns) {
      expect(remediationIds.has(p.patternId)).toBe(true);
    }
  });
});

describe("composeDigest — industry-misfit (barbershop)", () => {
  it("does NOT include restaurant-only Patterns in the LLM prompt", async () => {
    const reviews: ClassifiedReview[] = [
      makeReview({
        id: "r-bs-1",
        starRating: 2,
        redactedText: "Walk-in queue was out the door on Saturday morning.",
        themes: ["wait_time", "service"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-bs-2",
        starRating: 3,
        redactedText: "Booked appointments running 20 minutes late even though I arrived on time.",
        themes: ["wait_time"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-bs-3",
        starRating: 4,
        redactedText: "Fade was sharp but waited a while.",
        themes: ["wait_time", "service"],
        sentiment: "neutral",
      }),
    ];

    const { client, calls } = makeClient([loadFixture("barbershop-week")]);
    const result = await composeDigest(
      {
        reviews,
        business: { id: "biz-1", name: "Acme Cuts", industry: "barbershop" },
        playbook: PLAYBOOK,
        weekOverWeekTheme: {
          wait_time: { current: 3, previous: 1 },
          service: { current: 2, previous: 1 },
        },
        now: NOW,
      },
      { client },
    );

    expect(result.topPatterns).toHaveLength(3);

    // The user message we sent to Anthropic must list `barbershop-walkin-management`
    // as a candidate AND must NOT list restaurant-only Patterns like
    // `restaurant-table-turn-review` or `restaurant-food-safety-audit`.
    const userMsg = calls[0].messages[0].content;
    expect(userMsg).toContain('id="barbershop-walkin-management"');
    expect(userMsg).not.toContain('id="restaurant-table-turn-review"');
    expect(userMsg).not.toContain('id="restaurant-food-safety-audit"');
  });
});

describe("composeDigest — retry on Zod / candidate-id failure", () => {
  it("retries once when the first response references an unknown patternId, then succeeds", async () => {
    const reviews: ClassifiedReview[] = [
      makeReview({
        id: "r-wait-1",
        starRating: 2,
        redactedText: "Waited 25 minutes for a sandwich at lunch on Friday.",
        themes: ["wait_time"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-wait-2",
        starRating: 3,
        redactedText: "Long queue at the till around midday — fewer staff than usual.",
        themes: ["wait_time", "service"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-service-1",
        starRating: 1,
        redactedText: "[REVIEWER] was ignored at the counter for ten minutes.",
        themes: ["service"],
        sentiment: "negative",
      }),
      makeReview({
        id: "r-quality-1",
        starRating: 2,
        redactedText: "The pastries were stale on Tuesday morning.",
        themes: ["product_quality"],
        sentiment: "negative",
      }),
    ];

    const { client, calls } = makeClient([
      loadFixture("invalid-then-valid"),
      loadFixture("high-volume-mixed"),
    ]);
    const result = await composeDigest(
      {
        reviews,
        business: { id: "biz-1", name: "Acme Cafe", industry: "cafe" },
        playbook: PLAYBOOK,
        weekOverWeekTheme: {
          service: { current: 3, previous: 1 },
          wait_time: { current: 4, previous: 1 },
          product_quality: { current: 1, previous: 2 },
        },
        now: NOW,
      },
      { client },
    );

    expect(calls).toHaveLength(2);
    expect(result.topPatterns).toHaveLength(3);
    // The retry message must include the stricter framing.
    expect(calls[1].messages[0].content).toContain(
      "YOUR PREVIOUS RESPONSE FAILED SCHEMA VALIDATION",
    );
  });
});
