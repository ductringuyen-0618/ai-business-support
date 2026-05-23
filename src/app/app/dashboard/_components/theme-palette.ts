/**
 * Slice 13: centralised Theme → colour + sentiment-polarity mapping.
 *
 * Two palettes:
 *   - Negative-polarity Themes (the ones that mean "something is wrong"):
 *     warm tones (reds / oranges). They're meant to draw the Operator's eye
 *     in the stacked bar chart.
 *   - Positive-polarity Themes (the ones that mean "something is going well"):
 *     cool tones (blues / greens). They reinforce that things are healthy.
 *
 * Polarity is a per-Theme judgement call documented here so that the chart
 * legend and the Digest composer agree on which way each Theme points. The
 * Classifier emits a `sentiment` field per Review (positive / neutral /
 * negative) — that's about the Reviewer's tone, NOT the Theme. A Theme like
 * `staff_attitude` is intrinsically "bad if it shows up a lot" even when a
 * single Review mentioning it happens to be neutral. The chart aggregates
 * many Reviews, so per-Theme polarity is the right granularity.
 *
 * If a future Theme is added to `THEMES`, add it here too — the chart will
 * fall through to a neutral grey if the mapping is missing, which is OK as a
 * runtime fallback but is intentionally noisy in code review.
 */
import type { Theme } from "@/lib/classifier/schema";

export type ThemePolarity = "positive" | "negative" | "neutral";

export interface ThemePaletteEntry {
  /** Tailwind-compatible hex. Used by Recharts directly (Recharts wants a
   *  string colour value, not a Tailwind class name). */
  color: string;
  polarity: ThemePolarity;
  /** Order in the stacked bar — negative-polarity Themes stack on the bottom
   *  (so the "bad" colour mass is closest to the X-axis and easy to read). */
  stackOrder: number;
}

/**
 * Per-Theme palette entry. The colour choices target WCAG-AA contrast against
 * a white chart background; they were not picked to match the Tailwind
 * default palette exactly because the chart needs a wider range of distinct
 * hues than the dashboard's general greys + amber accents.
 */
export const THEME_PALETTE: Record<Theme, ThemePaletteEntry> = {
  // Negative-polarity Themes — warm tones, bottom of the stack.
  staff_attitude: { color: "#b91c1c", polarity: "negative", stackOrder: 0 },
  wait_time: { color: "#dc2626", polarity: "negative", stackOrder: 1 },
  pricing: { color: "#ea580c", polarity: "negative", stackOrder: 2 },
  cleanliness: { color: "#f59e0b", polarity: "negative", stackOrder: 3 },
  // Positive-polarity Themes — cool tones, top of the stack.
  product_quality: { color: "#0284c7", polarity: "positive", stackOrder: 4 },
  service: { color: "#0ea5e9", polarity: "positive", stackOrder: 5 },
  accessibility: { color: "#10b981", polarity: "positive", stackOrder: 6 },
  // Neutral — used when the classifier couldn't pick a meaningful Theme.
  other: { color: "#64748b", polarity: "neutral", stackOrder: 7 },
};

const NEUTRAL_FALLBACK: ThemePaletteEntry = {
  color: "#94a3b8",
  polarity: "neutral",
  stackOrder: 99,
};

export function paletteFor(theme: string): ThemePaletteEntry {
  return (THEME_PALETTE as Record<string, ThemePaletteEntry>)[theme] ?? NEUTRAL_FALLBACK;
}

/**
 * Ordered list of Themes for legend rendering. Sorted by `stackOrder` so the
 * legend, the bars, and the click-to-filter buttons all agree on order.
 */
export function orderedThemes(): Theme[] {
  return (Object.keys(THEME_PALETTE) as Theme[]).sort(
    (a, b) => THEME_PALETTE[a].stackOrder - THEME_PALETTE[b].stackOrder,
  );
}
