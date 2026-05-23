/**
 * Small visual chip for a Theme name. Used in row summary + drawer.
 * Theme labels are stored as snake_case in the DB; we humanise on render.
 */
import type { Theme } from "@/lib/classifier/schema";

const LABELS: Record<Theme, string> = {
  service: "Service",
  product_quality: "Product quality",
  cleanliness: "Cleanliness",
  wait_time: "Wait time",
  pricing: "Pricing",
  staff_attitude: "Staff attitude",
  accessibility: "Accessibility",
  other: "Other",
};

export function themeLabel(t: string): string {
  return (LABELS as Record<string, string>)[t] ?? t;
}

export function ThemePill({ theme }: { theme: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700">
      {themeLabel(theme)}
    </span>
  );
}
