"use client";

/**
 * Compact Review summary row for the dashboard list (slice 12).
 *
 * Click → opens the `ReviewDrawer` for the full Review + Classification +
 * Incident view. The row itself is a client component because the click
 * handler needs `useState`; the rendered DOM is static (text + pills).
 *
 * Display rules from issue #14:
 *   - Reviewer display name OR "[redacted]" if `reviewer_display_name IS NULL`
 *     (slice-15 deletion-request null-out).
 *   - Star rating (visual).
 *   - posted_at relative + absolute on hover (title attr).
 *   - First ~200 chars of `review_text`, fallback to `redacted_text` if the
 *     raw text was nulled by a Deletion Request.
 *   - Theme pills from the Classification.
 *   - Incident pill if there's an Incident row (regardless of resolved state).
 */
import { useState } from "react";

import type { ClassificationRow, IncidentRow, ReviewRow } from "@/db/schema";

import { ReviewDrawer } from "./review-drawer";
import { StarRating } from "./star-rating";
import { ThemePill } from "./theme-pill";

export interface ReviewRowProps {
  review: ReviewRow;
  classification: ClassificationRow | null;
  incident: IncidentRow | null;
}

const SUMMARY_CHAR_CAP = 200;

export function ReviewRow({ review, classification, incident }: ReviewRowProps) {
  const [open, setOpen] = useState(false);
  const reviewerName = review.reviewerDisplayName ?? "[redacted]";
  const snippetSource = review.reviewText ?? review.redactedText;
  const snippet =
    snippetSource.length > SUMMARY_CHAR_CAP
      ? `${snippetSource.slice(0, SUMMARY_CHAR_CAP).trimEnd()}…`
      : snippetSource;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full rounded-lg border border-slate-200 bg-white p-4 text-left transition hover:border-slate-300 hover:bg-slate-50"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-slate-900">{reviewerName}</span>
            <StarRating value={review.starRating} />
            {incident ? (
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                  incident.resolvedAt
                    ? "border-slate-200 bg-slate-50 text-slate-600"
                    : "border-red-200 bg-red-50 text-red-800"
                }`}
              >
                {incident.resolvedAt ? "Incident · resolved" : "Incident"}
              </span>
            ) : null}
          </div>
          <time
            dateTime={review.postedAt.toISOString()}
            title={review.postedAt.toISOString()}
            className="text-xs text-slate-500"
          >
            {formatRelative(review.postedAt)}
          </time>
        </div>
        <p className="mt-2 line-clamp-3 text-sm text-slate-700">{snippet}</p>
        {classification && classification.themes.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {classification.themes.map((t) => (
              <ThemePill key={t} theme={t} />
            ))}
          </div>
        ) : !classification ? (
          <div className="mt-3 text-xs italic text-slate-400">Not yet classified.</div>
        ) : null}
      </button>
      {open ? (
        <ReviewDrawer
          review={review}
          classification={classification}
          incident={incident}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Rough "N units ago" string. Avoids pulling a date library for one widget. */
function formatRelative(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
