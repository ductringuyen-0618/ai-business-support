/**
 * SourceAdapter — the abstraction every external review platform (Source)
 * plugs into. The ingest pipeline talks only to this interface, so adding
 * Yelp / Facebook later means writing a new adapter, not touching the pipeline.
 *
 * Naming reminder (see CONTEXT.md): "Source" = the external platform we
 * ingest from (Google, Yelp, ...). "Review" = a single piece of public
 * feedback from a Reviewer. "Reviewer" = the end-customer who posted it.
 *
 * No DB schema is created in this slice. The `source_connections` table
 * lands in slice 8 (issue #9). For now `SourceConnection` is purely the
 * in-memory shape an adapter needs.
 */

/**
 * Canonical in-memory shape of a Review produced by an adapter. Mirrors the
 * `reviews` table sketch in the PRD (issue #1): one row per Source review,
 * keyed downstream by `(source, source_review_id)` for idempotent upsert.
 *
 * `review_text` and `reviewer_display_name` are nullable because:
 *  - Google allows star-only Reviews (5 stars, no comment) → `review_text` null.
 *  - After a Reviewer Deletion Request (see CONTEXT.md, ADR-0006) we null both
 *    fields in place while keeping the row.
 *
 * Downstream handlers (Redactor in slice 3, Classifier in slice 4) MUST treat
 * `review_text === null` as "nothing to classify / redact" rather than crashing.
 */
export interface Review {
  /** Stable id from the Source — e.g. the trailing segment of Google's `name`. */
  source_review_id: string;
  /** 1..5. Google returns enum strings like `FIVE`; the adapter normalises. */
  star_rating: number;
  /** Null for star-only Reviews or Reviews that have been redacted on request. */
  review_text: string | null;
  /** Null when the Source omits the Reviewer name or it was nulled on request. */
  reviewer_display_name: string | null;
  /** Parsed from the platform's RFC 3339 `createTime`. */
  posted_at: Date;
  /**
   * Source-specific raw fields the ingest pipeline may want to reason about
   * without re-fetching. Kept optional + typed per-source so downstream code
   * can stay strict.
   */
  google?: {
    /** RFC 3339 timestamp of the last edit on Google's side, if any. */
    update_time?: string;
    /** Free-form reply text the Business already posted on Google, if any. */
    review_reply?: string;
  };
}

/**
 * In-memory snapshot of a row from the (future, slice-8) `source_connections`
 * table — one per (Business, Source) pairing. Holds the OAuth tokens an
 * adapter needs to talk to the Source.
 *
 * Token refresh is explicitly NOT the adapter's job in this slice. If the
 * Source rejects the access token, the adapter throws `TokenExpiredError`
 * and the caller (slice 10's backfill job handler) decides what to do
 * (refresh via the refresh token, mark the connection errored, prompt
 * re-auth).
 */
export interface SourceConnection {
  /** UUID of the row in `source_connections`. */
  id: string;
  /** Discriminator. Add `"yelp" | "facebook"` here when those adapters land. */
  source: "google";
  oauth_access_token: string;
  oauth_refresh_token: string;
}

/**
 * Result of one paginated fetch. `nextPageToken` is absent on the last page.
 */
export interface IngestPage {
  reviews: Review[];
  nextPageToken?: string;
}

export interface SourceAdapter {
  /**
   * Fetch one page of Reviews. The caller drives pagination by feeding the
   * returned `nextPageToken` back in until it's undefined. This is the
   * unit-of-work for the `backfill_source` job (ADR-0007) — one page per
   * job dispatch keeps each retry cheap and idempotent.
   *
   * Throws:
   *  - `TokenExpiredError` when the Source rejects the access token.
   *  - `RateLimitError` only if the adapter's internal retry budget is
   *    exhausted; transient 429s are swallowed by exponential backoff.
   */
  ingestPage(connection: SourceConnection, pageToken?: string): Promise<IngestPage>;

  /**
   * Set up a push subscription so the Source notifies us when new Reviews
   * appear (Google Business Profile Pub/Sub topic, per ADR-0007's "fresh
   * Review ingest runs on a separate Pub/Sub path"). Wired up in slice 10.
   */
  subscribeForUpdates(connection: SourceConnection): Promise<void>;
}

/**
 * Thrown when the Source rejects the adapter's access token. Caller is
 * expected to either refresh the token or mark the connection errored.
 * Not retried inside the adapter — token refresh is a slice-8/10 concern.
 */
export class TokenExpiredError extends Error {
  constructor(message = "Source access token is expired or invalid") {
    super(message);
    this.name = "TokenExpiredError";
  }
}

/**
 * Thrown by `ingestPage` only after the adapter's own retry budget for the
 * Source's 429s is exhausted. Caller (the backfill job handler) should
 * let pg-boss schedule the next attempt rather than spinning here.
 */
export class RateLimitError extends Error {
  constructor(
    message = "Source rate limit exceeded after adapter retries",
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}
