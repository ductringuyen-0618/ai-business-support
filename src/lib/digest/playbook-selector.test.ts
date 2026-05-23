import { describe, expect, it } from "vitest";

import { PLAYBOOK, type Theme } from "./playbook";
import { selectCandidates, type BusinessProfile, type ClassifiedReview } from "./playbook-selector";

function review(themes: Theme[], sentiment: ClassifiedReview["sentiment"]): ClassifiedReview {
  return { themes, sentiment };
}

const ANY_BUSINESS: BusinessProfile = { name: "Test Co" };

describe("selectCandidates", () => {
  it("returns an empty array when there are no Reviews this week", () => {
    const result = selectCandidates({ reviews: [], business: ANY_BUSINESS });
    expect(result).toEqual([]);
  });

  it("returns an empty array when Reviews exist but have no Themes", () => {
    const result = selectCandidates({
      reviews: [review([], "neutral")],
      business: ANY_BUSINESS,
    });
    expect(result).toEqual([]);
  });

  it("returns Patterns whose themes overlap with the week's Themes (high-volume mixed week)", () => {
    const reviews: ClassifiedReview[] = [
      review(["wait_time"], "negative"),
      review(["wait_time", "service"], "negative"),
      review(["pricing"], "negative"),
      review(["cleanliness"], "negative"),
      review(["product_quality"], "positive"),
    ];

    const candidates = selectCandidates({ reviews, business: ANY_BUSINESS });

    expect(candidates.length).toBeGreaterThan(0);

    const weekThemes = new Set<Theme>([
      "wait_time",
      "service",
      "pricing",
      "cleanliness",
      "product_quality",
    ]);
    for (const pattern of candidates) {
      expect(
        pattern.themes.some((t) => weekThemes.has(t)),
        `${pattern.id} has no Theme overlap with the week`,
      ).toBe(true);
    }

    // Patterns whose only Themes are outside the week (e.g. accessibility-only)
    // must NOT be returned.
    const accessibilityOnly = PLAYBOOK.find(
      (p) => p.themes.length === 1 && p.themes[0] === "accessibility",
    );
    if (accessibilityOnly) {
      expect(candidates.find((c) => c.id === accessibilityOnly.id)).toBeUndefined();
    }
  });

  it("returns ONLY reinforcement Patterns when the week is all positive and the LLM is steered there (selector returns the superset, kind filter is documented)", () => {
    // The selector itself is sentiment-agnostic by design — see ADR-0008,
    // the Digest LLM does the kind-routing. But the candidate set for an
    // all-positive week should still contain ALL reinforcement Patterns
    // that overlap the week's Themes. We assert that explicitly.
    const reviews: ClassifiedReview[] = [
      review(["service"], "positive"),
      review(["service", "staff_attitude"], "positive"),
      review(["product_quality"], "positive"),
      review(["cleanliness"], "positive"),
    ];

    const candidates = selectCandidates({ reviews, business: ANY_BUSINESS });

    const reinforcementCandidates = candidates.filter((p) => p.kind === "reinforcement");
    expect(reinforcementCandidates.length).toBeGreaterThanOrEqual(5);

    // Every reinforcement Pattern from the catalogue whose themes overlap
    // should appear in the candidates.
    const weekThemes = new Set<Theme>([
      "service",
      "staff_attitude",
      "product_quality",
      "cleanliness",
    ]);
    const expectedReinforcement = PLAYBOOK.filter(
      (p) => p.kind === "reinforcement" && p.themes.some((t) => weekThemes.has(t)),
    );
    for (const expected of expectedReinforcement) {
      expect(
        reinforcementCandidates.find((c) => c.id === expected.id),
        `missing reinforcement candidate ${expected.id}`,
      ).toBeDefined();
    }
  });

  it("excludes vertical-mismatched Patterns (barbershop does not get restaurant-only Patterns)", () => {
    const reviews: ClassifiedReview[] = [
      review(["wait_time"], "negative"),
      review(["cleanliness"], "negative"),
      review(["product_quality"], "negative"),
    ];

    const barbershop: BusinessProfile = { name: "Cut Above", industry: "barbershop" };
    const candidates = selectCandidates({ reviews, business: barbershop });

    // Restaurant-only Patterns must not appear.
    const restaurantOnly = PLAYBOOK.filter(
      (p) =>
        p.verticals && p.verticals.includes("restaurant") && !p.verticals.includes("barbershop"),
    );
    expect(restaurantOnly.length).toBeGreaterThan(0); // sanity: seed actually has restaurant-only entries

    for (const r of restaurantOnly) {
      expect(
        candidates.find((c) => c.id === r.id),
        `barbershop should not receive restaurant-only Pattern ${r.id}`,
      ).toBeUndefined();
    }

    // But barbershop-targeted vertical Patterns should appear when their
    // themes overlap.
    const barbershopPatterns = PLAYBOOK.filter(
      (p) =>
        p.verticals?.includes("barbershop") &&
        p.themes.some((t) => ["wait_time", "cleanliness", "product_quality"].includes(t)),
    );
    for (const b of barbershopPatterns) {
      expect(
        candidates.find((c) => c.id === b.id),
        `barbershop Pattern ${b.id} should be a candidate`,
      ).toBeDefined();
    }
  });

  it("includes a restaurant-specific Pattern when the Business is a restaurant and the Theme matches", () => {
    const reviews: ClassifiedReview[] = [review(["cleanliness", "product_quality"], "negative")];
    const restaurant: BusinessProfile = { name: "The Place", industry: "restaurant" };

    const candidates = selectCandidates({ reviews, business: restaurant });
    expect(candidates.find((c) => c.id === "restaurant-food-safety-audit")).toBeDefined();
  });

  it("treats a Business without an industry as 'universal only' — no vertical-restricted Patterns", () => {
    const reviews: ClassifiedReview[] = [review(["wait_time"], "negative")];
    const noIndustry: BusinessProfile = { name: "Unknown Co" };

    const candidates = selectCandidates({ reviews, business: noIndustry });
    for (const pattern of candidates) {
      expect(
        !pattern.verticals || pattern.verticals.length === 0,
        `${pattern.id} is vertical-restricted but was returned for an industry-less Business`,
      ).toBe(true);
    }
  });

  it("is case-insensitive on the industry slug", () => {
    const reviews: ClassifiedReview[] = [review(["cleanliness"], "negative")];
    const upper: BusinessProfile = { name: "Loud Co", industry: "RESTAURANT" };

    const candidates = selectCandidates({ reviews, business: upper });
    expect(candidates.find((c) => c.id === "restaurant-food-safety-audit")).toBeDefined();
  });

  it("is a pure function — does not mutate its inputs", () => {
    const reviews: ClassifiedReview[] = [review(["wait_time"], "negative")];
    const reviewsCopy = JSON.parse(JSON.stringify(reviews));
    const business: BusinessProfile = { name: "A", industry: "cafe" };
    const businessCopy = { ...business };

    selectCandidates({ reviews, business });

    expect(reviews).toEqual(reviewsCopy);
    expect(business).toEqual(businessCopy);
  });

  it("returns candidates in stable declaration order", () => {
    const reviews: ClassifiedReview[] = [review(["service", "wait_time", "pricing"], "negative")];
    const a = selectCandidates({ reviews, business: ANY_BUSINESS });
    const b = selectCandidates({ reviews, business: ANY_BUSINESS });
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));

    // Order must match PLAYBOOK declaration order.
    const expectedOrder = PLAYBOOK.filter((p) => a.find((c) => c.id === p.id)).map((p) => p.id);
    expect(a.map((p) => p.id)).toEqual(expectedOrder);
  });
});
