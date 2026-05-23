/**
 * Pure-function unit tests for `shape-trends.ts`.
 *
 * Inputs: arrays of query-layer shape (StarRatingTrendPoint[],
 * ThemeFrequencyBucket[]). Outputs: Recharts-ready wide-form shapes.
 *
 * Covers issue #15 AC:
 *   - "Component tests on the data-shaping functions"
 *   - Empty-input → empty output (drives the trends-section empty state).
 *   - Performance soft-check: 3,000-row dataset reshapes in under 500ms.
 */
import { describe, expect, it } from "vitest";

import { THEMES } from "@/lib/classifier/schema";
import type { StarRatingTrendPoint, ThemeFrequencyBucket } from "@/db/queries/trends";

import { legendThemes, shapeStarTrend, shapeThemeFrequency } from "./shape-trends";

describe("shapeStarTrend", () => {
  it("returns [] for empty input (drives the empty-state UI)", () => {
    expect(shapeStarTrend([])).toEqual([]);
  });

  it("maps to ISO date strings and rounds float fields to 2dp", () => {
    const rows: StarRatingTrendPoint[] = [
      {
        date: new Date("2026-05-20T00:00:00Z"),
        count: 7,
        dayAvg: 3.428571,
        rollingAvg: 4.123456,
      },
      {
        date: new Date("2026-05-21T00:00:00Z"),
        count: 1,
        dayAvg: 5,
        rollingAvg: 4.5,
      },
    ];
    expect(shapeStarTrend(rows)).toEqual([
      { date: "2026-05-20", count: 7, dayAvg: 3.43, rollingAvg: 4.12 },
      { date: "2026-05-21", count: 1, dayAvg: 5, rollingAvg: 4.5 },
    ]);
  });
});

describe("shapeThemeFrequency", () => {
  it("returns [] for empty input", () => {
    expect(shapeThemeFrequency([])).toEqual([]);
  });

  it("pivots long-form to wide-form, zero-filling missing Themes", () => {
    const rows: ThemeFrequencyBucket[] = [
      { weekStart: new Date("2026-05-18T00:00:00Z"), theme: "service", count: 3 },
      { weekStart: new Date("2026-05-18T00:00:00Z"), theme: "pricing", count: 1 },
      { weekStart: new Date("2026-05-25T00:00:00Z"), theme: "staff_attitude", count: 2 },
    ];
    const out = shapeThemeFrequency(rows);
    expect(out).toHaveLength(2);
    expect(out[0].weekStart).toBe("2026-05-18");
    expect(out[0].counts.service).toBe(3);
    expect(out[0].counts.pricing).toBe(1);
    // Zero-filled — Recharts reads `0` for stacked bars.
    expect(out[0].counts.staff_attitude).toBe(0);
    expect(out[0].total).toBe(4);
    expect(out[1].weekStart).toBe("2026-05-25");
    expect(out[1].counts.staff_attitude).toBe(2);
    expect(out[1].total).toBe(2);
  });

  it("drops Themes outside the canonical THEMES set", () => {
    const rows: ThemeFrequencyBucket[] = [
      { weekStart: new Date("2026-05-18T00:00:00Z"), theme: "service", count: 1 },
      { weekStart: new Date("2026-05-18T00:00:00Z"), theme: "not_a_theme", count: 99 },
    ];
    const out = shapeThemeFrequency(rows);
    expect(out).toHaveLength(1);
    expect(out[0].counts.service).toBe(1);
    expect(out[0].total).toBe(1);
  });

  it("sorts weeks chronologically", () => {
    const rows: ThemeFrequencyBucket[] = [
      { weekStart: new Date("2026-05-25T00:00:00Z"), theme: "service", count: 1 },
      { weekStart: new Date("2026-05-11T00:00:00Z"), theme: "service", count: 1 },
      { weekStart: new Date("2026-05-18T00:00:00Z"), theme: "service", count: 1 },
    ];
    expect(shapeThemeFrequency(rows).map((r) => r.weekStart)).toEqual([
      "2026-05-11",
      "2026-05-18",
      "2026-05-25",
    ]);
  });
});

describe("legendThemes", () => {
  it("returns [] when the series is empty", () => {
    expect(legendThemes([])).toEqual([]);
  });

  it("returns only Themes that have at least one non-zero bar in the series", () => {
    const series = shapeThemeFrequency([
      { weekStart: new Date("2026-05-18T00:00:00Z"), theme: "service", count: 3 },
      { weekStart: new Date("2026-05-18T00:00:00Z"), theme: "pricing", count: 1 },
    ]);
    expect(legendThemes(series).sort()).toEqual(["pricing", "service"]);
  });
});

describe("performance soft-check", () => {
  it("shapes a 1-year × 3,000-Review dataset in under 500ms", () => {
    // Build a synthetic 1-year dataset: ~3,000 buckets over the year for
    // ThemeFrequency, ~365 for the StarTrend (one per day).
    const start = new Date("2026-01-01T00:00:00Z");
    const starRows: StarRatingTrendPoint[] = [];
    for (let i = 0; i < 365; i += 1) {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + i);
      starRows.push({
        date: day,
        count: 8 + (i % 4),
        dayAvg: 3 + (i % 3) * 0.3,
        rollingAvg: 3.5 + (i % 5) * 0.1,
      });
    }
    const themeRows: ThemeFrequencyBucket[] = [];
    for (let week = 0; week < 52; week += 1) {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + week * 7);
      for (const t of THEMES) {
        themeRows.push({ weekStart: day, theme: t, count: 5 + ((week + t.length) % 7) });
      }
    }
    // The Review count this models: ~365 days × ~9 Reviews/day ≈ 3,285.

    const t0 = performance.now();
    const star = shapeStarTrend(starRows);
    const themes = shapeThemeFrequency(themeRows);
    legendThemes(themes);
    const elapsed = performance.now() - t0;

    expect(star).toHaveLength(365);
    expect(themes).toHaveLength(52);
    // Soft bound: well under 500ms on any modern laptop. If this fails it
    // means someone introduced a quadratic — that's the regression we care
    // about, not the absolute timing.
    expect(elapsed).toBeLessThan(500);
  });
});
