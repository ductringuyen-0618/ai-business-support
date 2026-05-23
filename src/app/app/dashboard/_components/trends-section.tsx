"use client";

/**
 * Slice 13: collapsible Trends section.
 *
 * Sits above the Review list on `/app/dashboard`. Hosts two charts:
 *   - Rolling-30-day star-rating line.
 *   - Per-ISO-week Theme frequency stacked bar with a click-to-filter legend.
 *
 * Both are passed already-shaped data from the server component so this
 * component is a thin presentational wrapper + disclosure toggle. The
 * disclosure default is "open" — the AC asks the charts to be visible above
 * the list, but Operators looking only at the list shouldn't have to scroll
 * past a wall of chart pixels every page-load on a phone, so we leave the
 * collapse affordance in.
 *
 * Empty-state contract: if BOTH series are empty (no Reviews in the selected
 * range), we render a single polite message instead of two broken-axis
 * charts. AC: "if zero Reviews in the selected range, both charts show a
 * polite empty state".
 */
import { useState } from "react";

import type { DashboardFilters } from "./filters";
import type { StarTrendChartPoint, ThemeFrequencyChartBar } from "./shape-trends";
import { StarTrendChart } from "./star-trend-chart";
import { ThemeFrequencyChart } from "./theme-frequency-chart";

import type { Theme } from "@/lib/classifier/schema";

interface TrendsSectionProps {
  starTrend: StarTrendChartPoint[];
  themeFrequency: ThemeFrequencyChartBar[];
  themeLegend: Theme[];
  filters: DashboardFilters;
}

export function TrendsSection({
  starTrend,
  themeFrequency,
  themeLegend,
  filters,
}: TrendsSectionProps) {
  const [open, setOpen] = useState(true);

  const isEmpty = starTrend.length === 0 && themeFrequency.length === 0;

  return (
    <section aria-label="Review trends" className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Trends</h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
          aria-expanded={open}
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open ? (
        isEmpty ? (
          <div className="mt-3 rounded-md border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
            No Reviews in this date range — try widening the filter.
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                Rolling 30-day average star rating
              </h3>
              {starTrend.length > 0 ? (
                <StarTrendChart data={starTrend} />
              ) : (
                <p className="text-xs text-slate-500">No rated Reviews in this range.</p>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                Theme frequency by ISO week
              </h3>
              {themeFrequency.length > 0 ? (
                <ThemeFrequencyChart data={themeFrequency} legend={themeLegend} filters={filters} />
              ) : (
                <p className="text-xs text-slate-500">No classified Reviews in this range.</p>
              )}
            </div>
          </div>
        )
      ) : null}
    </section>
  );
}
