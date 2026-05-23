"use client";

/**
 * Backfill banner for the dashboard top (slice 12, issue #14).
 *
 * Renders one of four banner flavours from the connected Google
 * `source_connections` row:
 *   - status='errored' → orange "Reconnect Google".
 *   - backfill_status='failed' → red "Retry backfill" (POST endpoint).
 *   - backfill_status in {pending, running} → blue progress.
 *   - backfill_status='complete' → no banner.
 *
 * The retry POST goes through `/api/sources/:id/retry-backfill` which
 * re-enqueues a fresh `backfill_source` job. We refresh the route on success
 * so the banner re-renders with the new state.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface BackfillBannerProps {
  connectionId: string;
  status: "pending" | "healthy" | "errored" | "disconnected";
  backfillStatus: "pending" | "running" | "complete" | "failed";
  loadedCount: number;
  estimatedTotal: number | null;
}

export function BackfillBanner(props: BackfillBannerProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (props.status === "errored") {
    return (
      <div
        role="status"
        className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      >
        <span>
          We can&apos;t reach Google with your saved credentials — please reconnect to resume
          ingesting Reviews.
        </span>
        <a
          href="/api/sources/google/oauth/start"
          className="inline-flex items-center rounded-md bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800"
        >
          Reconnect Google
        </a>
      </div>
    );
  }

  if (props.backfillStatus === "failed") {
    async function retry() {
      setBusy(true);
      try {
        const resp = await fetch(`/api/sources/${props.connectionId}/retry-backfill`, {
          method: "POST",
        });
        if (!resp.ok) {
          console.error("[dashboard] retry-backfill failed:", resp.status);
        }
        router.refresh();
      } finally {
        setBusy(false);
      }
    }
    return (
      <div
        role="alert"
        className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
      >
        <span>
          Backfill failed — we couldn&apos;t finish pulling your historical Reviews. Retry to resume
          from where we left off.
        </span>
        <button
          type="button"
          onClick={retry}
          disabled={busy}
          className="inline-flex items-center rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50"
        >
          {busy ? "Retrying…" : "Retry backfill"}
        </button>
      </div>
    );
  }

  if (props.backfillStatus === "pending" || props.backfillStatus === "running") {
    const total = props.estimatedTotal ?? null;
    const pct =
      total && total > 0 ? Math.min(100, Math.round((props.loadedCount / total) * 100)) : 0;
    return (
      <div
        role="status"
        className="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
      >
        <div className="flex items-center justify-between gap-3">
          <span>
            {props.backfillStatus === "pending"
              ? "We’re queued to start pulling your historical Google Reviews…"
              : "Backfilling your historical Google Reviews…"}{" "}
            <span className="font-medium">
              {props.loadedCount}
              {total !== null ? ` / ~${total}` : ""}
            </span>
          </span>
          {total !== null ? <span className="text-xs text-sky-700">{pct}%</span> : null}
        </div>
        {total !== null ? (
          <div className="mt-2 h-1.5 w-full rounded-full bg-sky-100">
            <div
              className="h-1.5 rounded-full bg-sky-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
      </div>
    );
  }

  // backfillStatus === 'complete' — no banner.
  return null;
}
