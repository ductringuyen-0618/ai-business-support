/**
 * GoogleAdapter — `SourceAdapter` implementation for Google Business Profile.
 *
 * Two modes, toggled by `GOOGLE_ADAPTER_MODE`:
 *  - `fixture` (default): reads recorded JSON fixtures from
 *    `__fixtures__/google/`. Used in tests and local dev so we can ship this
 *    slice before the Google Cloud project / OAuth client / Pub/Sub topic
 *    are wired up (those land in slices 8 and 10).
 *  - `live`: would call the real Google Business Profile API. Stubbed in this
 *    slice — slice 10 fills it in alongside the OAuth + Pub/Sub plumbing.
 *
 * In fixture mode, the caller selects scenarios via `pageToken`:
 *  - `undefined`            → `single-page.json` (5 Reviews, last page)
 *  - `"empty"`              → `empty-profile.json`
 *  - `"expired-token"`      → throws `TokenExpiredError`
 *  - `"rate-limit"`         → 429 every retry; throws `RateLimitError`
 *  - `"rate-limit-then-ok"` → 429 first call, then `single-page.json`
 *  - `"multi-page"`         → `multi-page-1.json` (chains via `nextPageToken`)
 *  - `"page-2-token"`       → `multi-page-2.json`
 *  - `"page-3-token"`       → `multi-page-3.json`
 *
 * The shapes of the fixtures match Google Business Profile API v4 responses
 * (`reviews[]` with `reviewer.displayName`, `starRating` enum, `comment`,
 * `createTime`, `updateTime`, `name`) so the `live` mode in slice 10 reuses
 * this mapping unchanged.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RateLimitError,
  type IngestPage,
  type Review,
  type SourceAdapter,
  type SourceConnection,
  TokenExpiredError,
} from "./source-adapter";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export type GoogleAdapterMode = "fixture" | "live";

const STAR_RATING_MAP: Record<string, number> = {
  STAR_RATING_UNSPECIFIED: 0,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

/**
 * Raw Google Business Profile review shape — only the fields we map. See
 * https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews
 */
interface GoogleApiReview {
  name?: string;
  reviewId?: string;
  reviewer?: {
    displayName?: string;
    profilePhotoUrl?: string;
  };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: {
    comment?: string;
    updateTime?: string;
  };
}

interface GoogleApiListReviewsResponse {
  reviews?: GoogleApiReview[];
  nextPageToken?: string;
}

interface GoogleApiErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ "@type"?: string; reason?: string; retryDelay?: string }>;
  };
}

/**
 * Clock abstraction so the backoff timer can be stubbed in tests without
 * actually sleeping. Defaults to `setTimeout`.
 */
export interface Clock {
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface GoogleAdapterOptions {
  mode?: GoogleAdapterMode;
  /** Override `__fixtures__/google` location. Used by tests. */
  fixturesDir?: string;
  /** Clock for backoff sleeps. */
  clock?: Clock;
  /** Max retries on rate-limit. Default 3 (so 1s, 2s, 4s waits). */
  maxRateLimitRetries?: number;
  /** Base delay in ms for the exponential backoff. Default 1000. */
  baseBackoffMs?: number;
}

export class GoogleAdapter implements SourceAdapter {
  private readonly mode: GoogleAdapterMode;
  private readonly fixturesDir: string;
  private readonly clock: Clock;
  private readonly maxRateLimitRetries: number;
  private readonly baseBackoffMs: number;
  /**
   * Counter for `rate-limit-then-ok` so the same in-process adapter sees a
   * 429 on the first attempt and a success on the retry. Keyed by pageToken
   * so multiple scenarios in one test don't collide.
   */
  private readonly transientCounters = new Map<string, number>();

  constructor(opts: GoogleAdapterOptions = {}) {
    this.mode = opts.mode ?? readModeFromEnv();
    this.fixturesDir = opts.fixturesDir ?? path.join(MODULE_DIR, "__fixtures__", "google");
    this.clock = opts.clock ?? realClock;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? 3;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
  }

  async ingestPage(connection: SourceConnection, pageToken?: string): Promise<IngestPage> {
    if (this.mode === "live") {
      throw new Error("NotImplemented: live Google API wired in Slice 10");
    }
    return this.ingestPageWithRetry(connection, pageToken, 0);
  }

  async subscribeForUpdates(_connection: SourceConnection): Promise<void> {
    throw new Error("NotImplemented: wired in Slice 10");
  }

  private async ingestPageWithRetry(
    connection: SourceConnection,
    pageToken: string | undefined,
    attempt: number,
  ): Promise<IngestPage> {
    try {
      return await this.fetchOnce(connection, pageToken);
    } catch (err) {
      if (err instanceof RateLimitError && attempt < this.maxRateLimitRetries) {
        const delay = this.baseBackoffMs * 2 ** attempt;
        await this.clock.sleep(delay);
        return this.ingestPageWithRetry(connection, pageToken, attempt + 1);
      }
      throw err;
    }
  }

  private async fetchOnce(
    _connection: SourceConnection,
    pageToken: string | undefined,
  ): Promise<IngestPage> {
    const fixtureName = this.selectFixture(pageToken);
    const raw = await this.loadFixture(fixtureName);

    // Error envelope?
    const errEnvelope = raw as GoogleApiErrorEnvelope;
    if (errEnvelope.error) {
      throw mapGoogleError(errEnvelope);
    }

    const body = raw as GoogleApiListReviewsResponse;
    const reviews = (body.reviews ?? []).map(mapGoogleReview);
    return body.nextPageToken ? { reviews, nextPageToken: body.nextPageToken } : { reviews };
  }

  private selectFixture(pageToken: string | undefined): string {
    if (pageToken === undefined) return "single-page";
    switch (pageToken) {
      case "empty":
        return "empty-profile";
      case "expired-token":
        return "expired-token";
      case "rate-limit":
        return "rate-limit";
      case "rate-limit-then-ok": {
        const seen = this.transientCounters.get(pageToken) ?? 0;
        this.transientCounters.set(pageToken, seen + 1);
        return seen === 0 ? "rate-limit" : "single-page";
      }
      case "multi-page":
        return "multi-page-1";
      case "page-2-token":
        return "multi-page-2";
      case "page-3-token":
        return "multi-page-3";
      default:
        // Unknown tokens fall back to the empty profile so tests get a
        // deterministic — not flaky — result rather than an exception.
        return "empty-profile";
    }
  }

  private async loadFixture(name: string): Promise<unknown> {
    const filePath = path.join(this.fixturesDir, `${name}.json`);
    const buf = await readFile(filePath, "utf8");
    return JSON.parse(buf) as unknown;
  }
}

function readModeFromEnv(): GoogleAdapterMode {
  const raw = process.env.GOOGLE_ADAPTER_MODE;
  if (raw === "live") return "live";
  // Default + any other value → fixture. Keeps CI / unit tests safe.
  return "fixture";
}

/**
 * Map a raw Google Business Profile review object to our canonical `Review`.
 * Exported for the live-mode adapter in slice 10 — same shape.
 */
export function mapGoogleReview(raw: GoogleApiReview): Review {
  const sourceReviewId = raw.reviewId ?? extractIdFromName(raw.name);
  if (!sourceReviewId) {
    throw new Error(
      "GoogleAdapter: review is missing both `reviewId` and `name` — cannot derive source_review_id",
    );
  }
  const star = STAR_RATING_MAP[raw.starRating ?? ""] ?? 0;
  const review: Review = {
    source_review_id: sourceReviewId,
    star_rating: star,
    review_text: raw.comment ?? null,
    reviewer_display_name: raw.reviewer?.displayName ?? null,
    posted_at: parseRfc3339(raw.createTime),
  };
  if (raw.updateTime || raw.reviewReply?.comment) {
    review.google = {};
    if (raw.updateTime) review.google.update_time = raw.updateTime;
    if (raw.reviewReply?.comment) review.google.review_reply = raw.reviewReply.comment;
  }
  return review;
}

function extractIdFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const parts = name.split("/");
  return parts[parts.length - 1] || undefined;
}

/**
 * Parse Google's RFC 3339 timestamps. V8's `Date` handles them including
 * fractional seconds + `Z` suffix; we wrap so we can throw on garbage rather
 * than propagate `Invalid Date` silently.
 */
function parseRfc3339(input: string | undefined): Date {
  if (!input) {
    throw new Error("GoogleAdapter: review is missing `createTime`");
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`GoogleAdapter: unparseable createTime "${input}"`);
  }
  return d;
}

function mapGoogleError(envelope: GoogleApiErrorEnvelope): Error {
  const code = envelope.error?.code;
  const reason = envelope.error?.details?.find((d) => d.reason)?.reason;
  if (code === 401 || reason === "ACCESS_TOKEN_EXPIRED") {
    return new TokenExpiredError(envelope.error?.message);
  }
  if (code === 429 || envelope.error?.status === "RESOURCE_EXHAUSTED") {
    const retryDelay = envelope.error?.details?.find((d) => d.retryDelay)?.retryDelay;
    const retryAfterSeconds = retryDelay ? parseRetryDelay(retryDelay) : undefined;
    return new RateLimitError(envelope.error?.message, retryAfterSeconds);
  }
  return new Error(
    `GoogleAdapter: unhandled Google error (code=${code ?? "?"}): ${
      envelope.error?.message ?? "unknown"
    }`,
  );
}

function parseRetryDelay(input: string): number | undefined {
  // Google sends durations like "30s". Anything else → undefined.
  const match = /^(\d+(?:\.\d+)?)s$/.exec(input);
  return match ? Number(match[1]) : undefined;
}
