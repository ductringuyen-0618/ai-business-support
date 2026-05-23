"use client";

/**
 * Slice 13: stacked Theme-frequency bar chart with click-to-filter legend.
 *
 * One bar per ISO week. Each bar is stacked by Theme. Negative-polarity
 * Themes use a red/orange palette; positive ones use blue/green. The legend
 * is interactive: clicking a Theme toggles it in the dashboard's URL
 * `themes` filter — the same source-of-truth the Review list reads from.
 *
 * Data shape is wide-form (one row per week with a `counts.<theme>` map).
 * See `shape-trends.ts` for the pivot from long-form SQL output.
 */
import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { Theme } from "@/lib/classifier/schema";

import { serializeDashboardFilters, type DashboardFilters } from "./filters";
import type { ThemeFrequencyChartBar } from "./shape-trends";
import { paletteFor } from "./theme-palette";
import { themeLabel } from "./theme-pill";

interface ThemeFrequencyChartProps {
  data: ThemeFrequencyChartBar[];
  legend: Theme[];
  filters: DashboardFilters;
}

/**
 * Recharts wants each `<Bar>` to point at a top-level numeric `dataKey`.
 * Our shape nests counts under `counts.<theme>`, so we pre-flatten each row
 * here for the chart. Keeping the wide-form pivot un-flattened in the
 * shape-trends helper is deliberate — the tooltip uses `total` and the test
 * suite asserts the nested shape.
 */
function flattenForChart(data: ThemeFrequencyChartBar[]): Array<Record<string, number | string>> {
  return data.map((row) => {
    const out: Record<string, number | string> = { weekStart: row.weekStart, total: row.total };
    for (const [theme, n] of Object.entries(row.counts)) {
      out[theme] = n;
    }
    return out;
  });
}

export function ThemeFrequencyChart({ data, legend, filters }: ThemeFrequencyChartProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/dashboard";

  const toggleTheme = useCallback(
    (t: Theme) => {
      const has = filters.themes.includes(t);
      const next: DashboardFilters = {
        ...filters,
        themes: has ? filters.themes.filter((x) => x !== t) : [...filters.themes, t],
        page: 1,
      };
      const qs = serializeDashboardFilters(next).toString();
      router.push(qs.length ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [filters, pathname, router],
  );

  if (data.length === 0) {
    return null;
  }

  const flat = flattenForChart(data);

  return (
    <div className="space-y-3">
      <div className="h-64 w-full" aria-label="Theme frequency by ISO week">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={flat} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
            <XAxis
              dataKey="weekStart"
              stroke="#64748b"
              fontSize={12}
              tickLine={false}
              axisLine={{ stroke: "#cbd5e1" }}
            />
            <YAxis
              stroke="#64748b"
              fontSize={12}
              tickLine={false}
              axisLine={{ stroke: "#cbd5e1" }}
              width={32}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: "#cbd5e1" }}
              formatter={(value, name) => {
                const v = typeof value === "number" || typeof value === "string" ? value : "";
                const label = typeof name === "string" ? themeLabel(name) : String(name ?? "");
                return [v, label] as [string | number, string];
              }}
              labelFormatter={(label, payload) => {
                const point = payload?.[0]?.payload as
                  | { weekStart: string; total: number }
                  | undefined;
                if (!point) return label;
                return `Week of ${point.weekStart} — ${point.total} Reviews`;
              }}
            />
            {legend.map((theme) => (
              <Bar
                key={theme}
                dataKey={theme}
                stackId="themes"
                fill={paletteFor(theme).color}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Theme legend — click to filter the Review list"
      >
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Themes</span>
        {legend.map((theme) => {
          const active = filters.themes.includes(theme);
          const color = paletteFor(theme).color;
          return (
            <button
              key={theme}
              type="button"
              onClick={() => toggleTheme(theme)}
              aria-pressed={active}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
                active
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              }`}
            >
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              {themeLabel(theme)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
