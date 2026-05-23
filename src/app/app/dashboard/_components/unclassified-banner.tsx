"use client";

/**
 * Small banner that surfaces Classifier failures (slice 12, issue #14).
 *
 * Shown only when `countUnclassifiedReviewsForBusiness > 0`. The button POSTs
 * to `/api/reviews/reclassify-failed` which re-enqueues `ingest_review` jobs
 * for up to 100 of the failed Reviews. The banner stays visible until the
 * worker drains the queue and a subsequent page refresh sees the count drop
 * to zero.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

export function UnclassifiedBanner({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (count <= 0) return null;

  async function onClick() {
    setBusy(true);
    try {
      const resp = await fetch("/api/reviews/reclassify-failed", { method: "POST" });
      if (!resp.ok) {
        console.error("[dashboard] reclassify-failed POST failed:", resp.status);
      } else {
        setDone(true);
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800"
    >
      <span>
        {count} Review{count === 1 ? "" : "s"} are missing a classification — likely a transient
        Anthropic outage.
      </span>
      <button
        type="button"
        onClick={onClick}
        disabled={busy || done}
        className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-100 disabled:opacity-50"
      >
        {done ? "Re-enqueued" : busy ? "Re-enqueuing…" : `Reclassify ${count} failed`}
      </button>
    </div>
  );
}
