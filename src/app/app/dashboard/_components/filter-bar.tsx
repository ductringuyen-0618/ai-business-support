"use client";

/**
 * URL-driven filter bar (slice 12, issue #14).
 *
 * The single source of truth is the URL query string — `parseDashboardFilters`
 * + `serializeDashboardFilters` (in `./filters.ts`) own the wire format and
 * have their own unit tests. This component is a thin React layer that
 * mutates the URL via `router.push`; the parent server component re-reads
 * the URL on the next render.
 *
 * Filters surfaced:
 *   - Theme multi-select (chips, 8 entries).
 *   - Date preset (last 7/30/90 days) + custom range with two yyyy-mm-dd
 *     inputs that appear only when preset === 'custom'.
 *   - Star rating multi-select 1..5.
 *   - "Incidents only" toggle.
 *   - "Clear filters" button (resets URL to `/app/dashboard`).
 */
import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";

import { THEMES, type Theme } from "@/lib/classifier/schema";

import {
  DATE_PRESETS,
  DEFAULT_FILTERS,
  STAR_RATINGS,
  serializeDashboardFilters,
  type DashboardFilters,
  type DatePreset,
  type StarRating,
} from "./filters";
import { themeLabel } from "./theme-pill";

export function FilterBar({ filters }: { filters: DashboardFilters }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/dashboard";

  const update = useCallback(
    (next: DashboardFilters) => {
      const qs = serializeDashboardFilters({ ...next, page: 1 }).toString();
      router.push(qs.length ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  function toggleTheme(t: Theme) {
    const has = filters.themes.includes(t);
    update({
      ...filters,
      themes: has ? filters.themes.filter((x) => x !== t) : [...filters.themes, t],
    });
  }

  function toggleRating(n: StarRating) {
    const has = filters.ratings.includes(n);
    update({
      ...filters,
      ratings: has ? filters.ratings.filter((x) => x !== n) : [...filters.ratings, n],
    });
  }

  function setPreset(p: DatePreset | null) {
    update({
      ...filters,
      preset: p,
      // Stash custom dates only when the user is in custom mode; clearing the
      // preset back to null also clears the boundaries so the URL stays tidy.
      since: p === "custom" ? filters.since : null,
      until: p === "custom" ? filters.until : null,
    });
  }

  function setSince(v: string) {
    update({ ...filters, preset: "custom", since: v.length ? v : null });
  }

  function setUntil(v: string) {
    update({ ...filters, preset: "custom", until: v.length ? v : null });
  }

  function toggleIncidents() {
    update({ ...filters, incidentsOnly: !filters.incidentsOnly });
  }

  function clearAll() {
    update(DEFAULT_FILTERS);
  }

  const anyActive =
    filters.themes.length > 0 ||
    filters.ratings.length > 0 ||
    filters.preset !== null ||
    filters.incidentsOnly;

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Themes</span>
        {THEMES.map((t) => {
          const active = filters.themes.includes(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggleTheme(t)}
              aria-pressed={active}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300"
              }`}
            >
              {themeLabel(t)}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Rating</span>
        {STAR_RATINGS.map((n) => {
          const active = filters.ratings.includes(n);
          return (
            <button
              key={n}
              type="button"
              onClick={() => toggleRating(n)}
              aria-pressed={active}
              className={`rounded-md border px-2 py-0.5 text-xs font-medium transition ${
                active
                  ? "border-amber-500 bg-amber-50 text-amber-900"
                  : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300"
              }`}
            >
              {n}★
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Date</span>
        {DATE_PRESETS.map((p) => {
          const active = filters.preset === p;
          const label =
            p === "last_7_days"
              ? "Last 7 days"
              : p === "last_30_days"
                ? "Last 30 days"
                : p === "last_90_days"
                  ? "Last 90 days"
                  : "Custom";
          return (
            <button
              key={p}
              type="button"
              onClick={() => setPreset(active ? null : p)}
              aria-pressed={active}
              className={`rounded-md border px-2 py-0.5 text-xs font-medium transition ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300"
              }`}
            >
              {label}
            </button>
          );
        })}
        {filters.preset === "custom" ? (
          <span className="flex items-center gap-1 text-xs text-slate-600">
            <input
              type="date"
              value={filters.since ?? ""}
              onChange={(e) => setSince(e.target.value)}
              className="rounded border border-slate-300 px-1 py-0.5"
              aria-label="From"
            />
            <span>→</span>
            <input
              type="date"
              value={filters.until ?? ""}
              onChange={(e) => setUntil(e.target.value)}
              className="rounded border border-slate-300 px-1 py-0.5"
              aria-label="To"
            />
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={filters.incidentsOnly}
            onChange={toggleIncidents}
            className="h-3.5 w-3.5 rounded border-slate-300"
          />
          Incidents only
        </label>
        <button
          type="button"
          onClick={clearAll}
          disabled={!anyActive}
          className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline disabled:opacity-50"
        >
          Clear filters
        </button>
      </div>
    </div>
  );
}
