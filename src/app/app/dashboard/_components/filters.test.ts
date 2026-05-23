/**
 * Unit tests for the dashboard filter URL serializer (slice 12).
 *
 * The serialiser is pure data — no React — so we exercise the contract
 * directly. The round-trip property (parse → serialize → parse produces
 * an equivalent value) is the load-bearing invariant: it's what makes the
 * URL the source of truth for filter state.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILTERS,
  parseDashboardFilters,
  resolveDateRange,
  serializeDashboardFilters,
  type DashboardFilters,
} from "./filters";

function roundTrip(filters: DashboardFilters): DashboardFilters {
  const qs = serializeDashboardFilters(filters);
  const obj: Record<string, string> = {};
  for (const [k, v] of qs.entries()) obj[k] = v;
  return parseDashboardFilters(obj);
}

describe("parseDashboardFilters", () => {
  it("returns DEFAULT_FILTERS for empty searchParams", () => {
    expect(parseDashboardFilters({})).toEqual(DEFAULT_FILTERS);
  });

  it("parses a multi-theme query string", () => {
    const out = parseDashboardFilters({ themes: "service,cleanliness" });
    expect(out.themes).toEqual(["service", "cleanliness"]);
  });

  it("silently drops unknown themes (forward-compat with future taxonomy bumps)", () => {
    const out = parseDashboardFilters({ themes: "service,not_a_theme,cleanliness" });
    expect(out.themes).toEqual(["service", "cleanliness"]);
  });

  it("parses ratings as integers and discards out-of-range values", () => {
    const out = parseDashboardFilters({ ratings: "1,2,9,foo,5" });
    expect(out.ratings).toEqual([1, 2, 5]);
  });

  it("treats `incidents=1` as truthy and anything else as false", () => {
    expect(parseDashboardFilters({ incidents: "1" }).incidentsOnly).toBe(true);
    expect(parseDashboardFilters({ incidents: "0" }).incidentsOnly).toBe(false);
    expect(parseDashboardFilters({ incidents: "true" }).incidentsOnly).toBe(false);
    expect(parseDashboardFilters({}).incidentsOnly).toBe(false);
  });

  it("parses `page` as a 1-indexed positive integer with fallbacks", () => {
    expect(parseDashboardFilters({ page: "3" }).page).toBe(3);
    expect(parseDashboardFilters({ page: "0" }).page).toBe(1);
    expect(parseDashboardFilters({ page: "-1" }).page).toBe(1);
    expect(parseDashboardFilters({ page: "abc" }).page).toBe(1);
    expect(parseDashboardFilters({}).page).toBe(1);
  });

  it("accepts custom preset with explicit yyyy-mm-dd boundaries", () => {
    const out = parseDashboardFilters({
      preset: "custom",
      since: "2026-04-01",
      until: "2026-05-01",
    });
    expect(out.preset).toBe("custom");
    expect(out.since).toBe("2026-04-01");
    expect(out.until).toBe("2026-05-01");
  });

  it("drops malformed dates rather than throwing", () => {
    const out = parseDashboardFilters({ preset: "custom", since: "not-a-date" });
    expect(out.since).toBeNull();
  });

  it("treats the first value of an array-valued query param as canonical", () => {
    const out = parseDashboardFilters({ themes: ["service", "cleanliness"] });
    expect(out.themes).toEqual(["service"]);
  });
});

describe("serializeDashboardFilters", () => {
  it("produces an empty query for DEFAULT_FILTERS", () => {
    expect(serializeDashboardFilters(DEFAULT_FILTERS).toString()).toBe("");
  });

  it("emits themes as comma-joined", () => {
    const out = serializeDashboardFilters({
      ...DEFAULT_FILTERS,
      themes: ["service", "cleanliness"],
    });
    expect(out.get("themes")).toBe("service,cleanliness");
  });

  it("emits ratings sorted ascending so URL is canonical regardless of click order", () => {
    const out = serializeDashboardFilters({ ...DEFAULT_FILTERS, ratings: [5, 1, 3] });
    expect(out.get("ratings")).toBe("1,3,5");
  });

  it("omits since/until unless preset is custom", () => {
    const out = serializeDashboardFilters({
      ...DEFAULT_FILTERS,
      preset: "last_7_days",
      since: "2026-04-01",
      until: "2026-05-01",
    });
    expect(out.get("since")).toBeNull();
    expect(out.get("until")).toBeNull();
    expect(out.get("preset")).toBe("last_7_days");
  });

  it("omits page=1 (the default)", () => {
    const out = serializeDashboardFilters({ ...DEFAULT_FILTERS, page: 1 });
    expect(out.get("page")).toBeNull();
  });

  it("emits page when > 1", () => {
    const out = serializeDashboardFilters({ ...DEFAULT_FILTERS, page: 4 });
    expect(out.get("page")).toBe("4");
  });

  it("emits incidents=1 only when true", () => {
    expect(serializeDashboardFilters(DEFAULT_FILTERS).get("incidents")).toBeNull();
    expect(
      serializeDashboardFilters({ ...DEFAULT_FILTERS, incidentsOnly: true }).get("incidents"),
    ).toBe("1");
  });
});

describe("round-trip", () => {
  it("preserves a fully-populated filter set across parse → serialize → parse", () => {
    const filters: DashboardFilters = {
      themes: ["service", "cleanliness", "wait_time"],
      ratings: [1, 2, 5],
      preset: "custom",
      since: "2026-04-01",
      until: "2026-05-01",
      incidentsOnly: true,
      page: 3,
    };
    expect(roundTrip(filters)).toEqual(filters);
  });

  it("preserves a preset-only filter set", () => {
    const filters: DashboardFilters = {
      ...DEFAULT_FILTERS,
      preset: "last_30_days",
    };
    expect(roundTrip(filters)).toEqual(filters);
  });

  it("preserves the empty filter set as DEFAULT_FILTERS", () => {
    expect(roundTrip(DEFAULT_FILTERS)).toEqual(DEFAULT_FILTERS);
  });
});

describe("resolveDateRange", () => {
  const NOW = new Date("2026-05-23T12:00:00Z");

  it("returns null when no preset is set", () => {
    expect(resolveDateRange(DEFAULT_FILTERS, NOW)).toBeNull();
  });

  it("computes a 7-day range anchored on `now`", () => {
    const range = resolveDateRange({ ...DEFAULT_FILTERS, preset: "last_7_days" }, NOW);
    expect(range).not.toBeNull();
    expect(range!.until.toISOString()).toBe("2026-05-23T12:00:00.000Z");
    expect(range!.since.toISOString()).toBe("2026-05-16T12:00:00.000Z");
  });

  it("computes a 30-day range anchored on `now`", () => {
    const range = resolveDateRange({ ...DEFAULT_FILTERS, preset: "last_30_days" }, NOW);
    expect(range!.since.toISOString()).toBe("2026-04-23T12:00:00.000Z");
  });

  it("uses explicit boundaries for the custom preset", () => {
    const range = resolveDateRange(
      {
        ...DEFAULT_FILTERS,
        preset: "custom",
        since: "2026-04-01",
        until: "2026-05-01",
      },
      NOW,
    );
    expect(range!.since.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(range!.until.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("returns null for custom preset with no boundaries set (UI should treat as 'no filter')", () => {
    const range = resolveDateRange({ ...DEFAULT_FILTERS, preset: "custom" }, NOW);
    expect(range).toBeNull();
  });
});
