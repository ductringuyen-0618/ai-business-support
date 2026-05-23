/**
 * Pure URL-serialisation helpers for the dashboard filter bar (slice 12).
 *
 * The filter bar's state round-trips through the URL query string so views
 * are shareable + back-button-able (issue #14 AC). This module is the only
 * place that knows the wire format — both the server component (parsing
 * `searchParams`) and the client filter bar (writing the URL) import from
 * here, which means we never drift between read and write.
 *
 * Wire format (all keys optional):
 *
 *   ?themes=service,cleanliness
 *   &ratings=1,2
 *   &since=2026-04-23           (ISO date — UTC midnight)
 *   &until=2026-05-23           (ISO date — UTC midnight, inclusive)
 *   &preset=last_7_days|last_30_days|last_90_days|custom
 *   &incidents=1
 *   &page=2
 *
 * Empty values / missing keys parse to "no filter applied". The serializer
 * is the inverse — defaults are dropped from the output so the URL stays
 * short and a click-from-default produces an empty query.
 *
 * Kept as a plain function module (no React) so the unit tests can exercise
 * the round-trip in isolation. The slice-11 channels page (`serialize.ts` +
 * `serialize.test.ts`) follows the same shape — see that module for the
 * pattern this file inherits.
 */
import { THEMES, type Theme } from "@/lib/classifier/schema";

/**
 * Date-range presets surfaced by the UI. `custom` means the user typed
 * explicit `since` / `until` dates; the other three are computed at render
 * time from "today" so the URL stays stable across page loads (we do NOT
 * serialise the resolved boundaries — only the preset name + since/until
 * when the user is in `custom` mode).
 */
export const DATE_PRESETS = ["last_7_days", "last_30_days", "last_90_days", "custom"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const STAR_RATINGS = [1, 2, 3, 4, 5] as const;
export type StarRating = (typeof STAR_RATINGS)[number];

/**
 * In-memory filter state. The shape the server component receives after
 * parsing and the client component builds before serializing.
 */
export interface DashboardFilters {
  themes: Theme[];
  ratings: StarRating[];
  preset: DatePreset | null;
  /** Only meaningful when `preset === 'custom'`. ISO yyyy-mm-dd. */
  since: string | null;
  until: string | null;
  incidentsOnly: boolean;
  page: number;
}

export const DEFAULT_FILTERS: DashboardFilters = {
  themes: [],
  ratings: [],
  preset: null,
  since: null,
  until: null,
  incidentsOnly: false,
  page: 1,
};

export const PAGE_SIZE = 25;

/**
 * Parse a Next 15 `searchParams` map into a `DashboardFilters` value.
 *
 * Unknown / malformed values are silently dropped — the URL is a UX surface
 * for the Operator, not an API contract, so a stale share-link with an
 * obsolete Theme name should still render the rest of the filters rather
 * than 400. The integration tests pin the silent-drop behaviour.
 */
export function parseDashboardFilters(
  searchParams: Record<string, string | string[] | undefined>,
): DashboardFilters {
  return {
    themes: parseThemeList(firstValue(searchParams.themes)),
    ratings: parseRatingList(firstValue(searchParams.ratings)),
    preset: parsePreset(firstValue(searchParams.preset)),
    since: parseDate(firstValue(searchParams.since)),
    until: parseDate(firstValue(searchParams.until)),
    incidentsOnly: firstValue(searchParams.incidents) === "1",
    page: parsePage(firstValue(searchParams.page)),
  };
}

/**
 * Serialise filters back to URLSearchParams. Defaults are dropped so a
 * pristine state produces an empty string — that's what the "Clear filters"
 * button relies on.
 */
export function serializeDashboardFilters(filters: DashboardFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.themes.length > 0) {
    params.set("themes", filters.themes.join(","));
  }
  if (filters.ratings.length > 0) {
    // Always sorted so the URL is canonical (clicking 3 then 1 produces the
    // same URL as clicking 1 then 3 — the back-button behaviour is sane).
    params.set("ratings", [...filters.ratings].sort((a, b) => a - b).join(","));
  }
  if (filters.preset !== null) {
    params.set("preset", filters.preset);
  }
  if (filters.preset === "custom") {
    if (filters.since) params.set("since", filters.since);
    if (filters.until) params.set("until", filters.until);
  }
  if (filters.incidentsOnly) {
    params.set("incidents", "1");
  }
  if (filters.page > 1) {
    params.set("page", String(filters.page));
  }
  return params;
}

/**
 * Resolve the (`since`, `until`) date range a preset implies, anchored at
 * `now`. Returns null for the `null` preset (i.e. no date filter at all);
 * the server query then omits the date predicate.
 *
 * Both boundaries are inclusive UTC midnight. "Last 7 days" means rows whose
 * `posted_at` is within the last 7 days, anchored on `now`.
 */
export function resolveDateRange(
  filters: DashboardFilters,
  now: Date = new Date(),
): { since: Date; until: Date } | null {
  if (filters.preset === null) return null;
  if (filters.preset === "custom") {
    const since = filters.since ? safeParseDate(filters.since) : null;
    const until = filters.until ? safeParseDate(filters.until) : null;
    if (!since && !until) return null;
    return {
      // Custom range without one boundary: treat the missing boundary as
      // "open" — but we still need real dates for the query predicate, so
      // fall back to "epoch" / "far future" sentinels rather than letting
      // the query be unbounded on one side, which would surprise the user.
      since: since ?? new Date(0),
      until: until ?? new Date(now.getTime() + 24 * 60 * 60 * 1000),
    };
  }
  const days = filters.preset === "last_7_days" ? 7 : filters.preset === "last_30_days" ? 30 : 90;
  const until = new Date(now);
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { since, until };
}

// --- helpers ---

function firstValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function parseThemeList(raw: string | undefined): Theme[] {
  if (!raw) return [];
  const known = new Set<string>(THEMES);
  const out: Theme[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (known.has(trimmed)) {
      out.push(trimmed as Theme);
    }
  }
  // Dedupe preserving first-seen order (URL canonicality is nice but the
  // round-trip test only requires set-equality, which dedupe gives us).
  return Array.from(new Set(out));
}

function parseRatingList(raw: string | undefined): StarRating[] {
  if (!raw) return [];
  const out: StarRating[] = [];
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 1 && n <= 5) {
      out.push(n as StarRating);
    }
  }
  return Array.from(new Set(out));
}

function parsePreset(raw: string | undefined): DatePreset | null {
  if (!raw) return null;
  return (DATE_PRESETS as readonly string[]).includes(raw) ? (raw as DatePreset) : null;
}

function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  // yyyy-mm-dd. Coerce anything else to null rather than 400.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(raw + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return raw;
}

function safeParseDate(raw: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(raw + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function parsePage(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 1;
  return n;
}
