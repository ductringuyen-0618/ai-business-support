import { describe, expect, it } from "vitest";

import { PLAYBOOK, type Theme } from "./playbook";

const ALL_THEMES: readonly Theme[] = [
  "service",
  "product_quality",
  "cleanliness",
  "wait_time",
  "pricing",
  "staff_attitude",
  "accessibility",
  "other",
];

describe("PLAYBOOK catalogue", () => {
  it("contains between 30 and 60 entries", () => {
    expect(PLAYBOOK.length).toBeGreaterThanOrEqual(30);
    expect(PLAYBOOK.length).toBeLessThanOrEqual(60);
  });

  it("uses unique stable ids", () => {
    const ids = PLAYBOOK.map((p) => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("uses slug-style ids (lowercase, hyphen-separated)", () => {
    for (const pattern of PLAYBOOK) {
      expect(pattern.id, `id "${pattern.id}" should be a slug`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("declares at least one Theme per Pattern, using the fixed Theme set", () => {
    const themeSet = new Set<Theme>(ALL_THEMES);
    for (const pattern of PLAYBOOK) {
      expect(pattern.themes.length, `${pattern.id} has empty themes`).toBeGreaterThan(0);
      for (const theme of pattern.themes) {
        expect(themeSet.has(theme), `${pattern.id} uses unknown theme "${theme}"`).toBe(true);
      }
    }
  });

  it("has at least 3 remediation Patterns per Theme", () => {
    for (const theme of ALL_THEMES) {
      const count = PLAYBOOK.filter(
        (p) => p.kind === "remediation" && p.themes.includes(theme),
      ).length;
      expect(
        count,
        `theme "${theme}" has only ${count} remediation Patterns`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("has at least 5 reinforcement Patterns", () => {
    const reinforcement = PLAYBOOK.filter((p) => p.kind === "reinforcement");
    expect(reinforcement.length).toBeGreaterThanOrEqual(5);
  });

  it("includes vertical-specific Patterns demonstrating the verticals filter", () => {
    const verticalScoped = PLAYBOOK.filter((p) => p.verticals && p.verticals.length > 0);
    expect(verticalScoped.length).toBeGreaterThanOrEqual(3);

    const allVerticals = new Set(verticalScoped.flatMap((p) => p.verticals ?? []));
    // The seed must cover at least these verticals per the slice brief.
    for (const required of ["restaurant", "barbershop"]) {
      expect(allVerticals.has(required), `seed missing "${required}" vertical`).toBe(true);
    }
  });

  it("provides non-empty title, body, and signals on every Pattern", () => {
    for (const pattern of PLAYBOOK) {
      expect(pattern.title.trim().length, `${pattern.id} has empty title`).toBeGreaterThan(0);
      expect(pattern.body.trim().length, `${pattern.id} has empty body`).toBeGreaterThan(0);
      expect(pattern.signals.trim().length, `${pattern.id} has empty signals`).toBeGreaterThan(0);
    }
  });

  it("uses kind values from the {remediation, reinforcement} set only", () => {
    for (const pattern of PLAYBOOK) {
      expect(["remediation", "reinforcement"]).toContain(pattern.kind);
    }
  });
});
