"use client";

/**
 * Full-Review drawer (slice 12, issue #14).
 *
 * Surfaces:
 *   - Full Review text (or "[redacted]" body if nulled by a Deletion Request).
 *   - Reviewer + star rating + posted_at (absolute).
 *   - Full Classification — themes, severity, sentiment, suggested_reply.
 *   - Incident status if any. "Mark resolved" button when unresolved.
 *
 * The drawer is implemented as a fixed-position overlay (right-side slide-out)
 * with a click-outside-to-close backdrop. We chose a div-based modal rather
 * than the native `<dialog>` element because Tailwind v3 + Next 15 SSR has
 * known issues with `<dialog>` hydration; a div is simpler and accessible
 * via the `role="dialog"` + `aria-modal` attributes.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { ClassificationRow, IncidentRow, ReviewRow } from "@/db/schema";

import { StarRating } from "./star-rating";
import { ThemePill } from "./theme-pill";

export interface ReviewDrawerProps {
  review: ReviewRow;
  classification: ClassificationRow | null;
  incident: IncidentRow | null;
  onClose: () => void;
}

export function ReviewDrawer({ review, classification, incident, onClose }: ReviewDrawerProps) {
  const router = useRouter();
  const [resolving, setResolving] = useState(false);

  // Close on Escape so the modal feels native.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function markResolved() {
    if (!incident) return;
    setResolving(true);
    try {
      const resp = await fetch(`/api/incidents/${incident.id}/resolve`, { method: "POST" });
      if (!resp.ok) {
        console.error("[dashboard] mark-resolved failed:", resp.status);
      }
      router.refresh();
      onClose();
    } finally {
      setResolving(false);
    }
  }

  const reviewerName = review.reviewerDisplayName ?? "[redacted]";
  const bodyText = review.reviewText ?? "(Review text removed at the Reviewer’s request.)";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review details"
      className="fixed inset-0 z-50 flex"
    >
      <div
        className="flex-1 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="flex w-full max-w-xl flex-col overflow-y-auto bg-white shadow-2xl">
        <header className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-slate-900">{reviewerName}</h2>
              <StarRating value={review.starRating} />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Posted{" "}
              <time dateTime={review.postedAt.toISOString()}>{review.postedAt.toUTCString()}</time>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="space-y-6 px-6 py-5">
          <section>
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Review text
            </h3>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{bodyText}</p>
          </section>

          {classification ? (
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Classification
              </h3>
              <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">Sentiment</dt>
                  <dd className="font-medium text-slate-800">{classification.sentiment}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Severity</dt>
                  <dd className="font-medium text-slate-800">{classification.severity ?? "—"}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-slate-500">Themes</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {classification.themes.length === 0 ? (
                      <span className="text-xs italic text-slate-400">None</span>
                    ) : (
                      classification.themes.map((t) => <ThemePill key={t} theme={t} />)
                    )}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-slate-500">Suggested reply (copy &amp; paste)</dt>
                  <dd className="mt-1 whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
                    {classification.suggestedReply}
                  </dd>
                </div>
              </dl>
            </section>
          ) : (
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Classification
              </h3>
              <p className="mt-2 text-sm italic text-slate-500">
                Not yet classified — the LLM call hasn&apos;t succeeded for this Review. Try
                &ldquo;Reclassify failed&rdquo; from the banner.
              </p>
            </section>
          )}

          {incident ? (
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Incident
              </h3>
              <div className="mt-2 flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <span>
                  Fired{" "}
                  <time dateTime={incident.firedAt.toISOString()}>
                    {incident.firedAt.toUTCString()}
                  </time>
                  {incident.resolvedAt ? (
                    <>
                      , resolved{" "}
                      <time dateTime={incident.resolvedAt.toISOString()}>
                        {incident.resolvedAt.toUTCString()}
                      </time>
                    </>
                  ) : null}
                  . Severity: {incident.severity}.
                </span>
                {incident.resolvedAt ? (
                  <span className="text-xs font-medium text-slate-500">Resolved</span>
                ) : (
                  <button
                    type="button"
                    onClick={markResolved}
                    disabled={resolving}
                    className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {resolving ? "Resolving…" : "Mark resolved"}
                  </button>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
