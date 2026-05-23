"use client";

/**
 * Slice 13: rolling 30-day star-rating trend.
 *
 * Receives already-shaped data (`shapeStarTrend(...)`) as props. The data is
 * computed in SQL on the server (see `src/db/queries/trends.ts`); this
 * component is purely visual.
 *
 * Marked "use client" because Recharts uses browser APIs (SVG measurement,
 * ResizeObserver) that don't exist during SSR. The chart is hydrated into a
 * server-rendered placeholder so the layout doesn't jump.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { StarTrendChartPoint } from "./shape-trends";

interface StarTrendChartProps {
  data: StarTrendChartPoint[];
}

export function StarTrendChart({ data }: StarTrendChartProps) {
  if (data.length === 0) {
    // The trends-section parent already renders a polite empty state when
    // *neither* chart has data; we still guard here so a direct caller (or
    // a future tab) doesn't render a broken-axis chart.
    return null;
  }
  return (
    <div className="h-64 w-full" aria-label="Rolling 30-day average star rating">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            stroke="#64748b"
            fontSize={12}
            tickLine={false}
            axisLine={{ stroke: "#cbd5e1" }}
          />
          <YAxis
            domain={[1, 5]}
            ticks={[1, 2, 3, 4, 5]}
            stroke="#64748b"
            fontSize={12}
            tickLine={false}
            axisLine={{ stroke: "#cbd5e1" }}
            width={32}
          />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: "#cbd5e1" }}
            formatter={(value, name) => {
              const v = typeof value === "number" || typeof value === "string" ? value : "";
              if (name === "rollingAvg") return [Number(v).toFixed(2), "30-day avg"];
              return [v, name ?? ""] as [string | number, string];
            }}
            labelFormatter={(label, payload) => {
              const point = payload?.[0]?.payload as StarTrendChartPoint | undefined;
              if (!point) return label;
              return `${point.date} — ${point.count} Reviews (day avg ${point.dayAvg.toFixed(2)})`;
            }}
          />
          <Line
            type="monotone"
            dataKey="rollingAvg"
            stroke="#0f172a"
            strokeWidth={2}
            dot={false}
            // `connectNulls` so a quiet day between two non-empty days draws
            // a straight line through (we omit empty days from the series).
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
