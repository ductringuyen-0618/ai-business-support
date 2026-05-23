import { describe, expect, it, vi } from "vitest";

import { GoogleAdapter, mapGoogleReview, type Clock } from "../google-adapter";
import { RateLimitError, TokenExpiredError, type SourceConnection } from "../source-adapter";

function fakeConnection(): SourceConnection {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    source: "google",
    oauth_access_token: "fake-access",
    oauth_refresh_token: "fake-refresh",
  };
}

/** Clock that records sleep durations and never actually waits. */
function recordingClock(): Clock & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

describe("GoogleAdapter — fixture mode", () => {
  it("single-page fixture yields 5 normalised Reviews and no nextPageToken", async () => {
    const adapter = new GoogleAdapter({ mode: "fixture" });
    const result = await adapter.ingestPage(fakeConnection());

    expect(result.nextPageToken).toBeUndefined();
    expect(result.reviews).toHaveLength(5);

    const [first] = result.reviews;
    expect(first.source_review_id).toBe("AbZc-single-1");
    expect(first.star_rating).toBe(5);
    expect(first.review_text).toContain("Best coffee");
    expect(first.reviewer_display_name).toBe("Jane Doe");
    expect(first.posted_at).toBeInstanceOf(Date);
    expect(first.posted_at.toISOString()).toBe("2026-05-01T08:15:30.000Z");
  });

  it("empty profile returns an empty array and no token", async () => {
    const adapter = new GoogleAdapter({ mode: "fixture" });
    const result = await adapter.ingestPage(fakeConnection(), "empty");
    expect(result.reviews).toEqual([]);
    expect(result.nextPageToken).toBeUndefined();
  });

  it("paginated ingest walks all pages following nextPageToken", async () => {
    const adapter = new GoogleAdapter({ mode: "fixture" });
    const all: string[] = [];
    let token: string | undefined = "multi-page";
    let safety = 0;

    do {
      const page = await adapter.ingestPage(fakeConnection(), token);
      for (const r of page.reviews) all.push(r.source_review_id);
      token = page.nextPageToken;
      safety++;
      if (safety > 10) throw new Error("pagination did not terminate");
    } while (token);

    expect(all).toEqual([
      "AbZc-multi-1-a",
      "AbZc-multi-1-b",
      "AbZc-multi-2-a",
      "AbZc-multi-2-b",
      "AbZc-multi-3-a",
    ]);
    // 3 pages: token chain terminates on page 3 which has no nextPageToken.
    expect(safety).toBe(3);
  });

  it("expired-token fixture throws TokenExpiredError", async () => {
    const adapter = new GoogleAdapter({ mode: "fixture" });
    await expect(adapter.ingestPage(fakeConnection(), "expired-token")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
  });

  it("rate-limit fixture retries with exponential backoff (1s, 2s, 4s) before surfacing", async () => {
    const clock = recordingClock();
    const adapter = new GoogleAdapter({
      mode: "fixture",
      clock,
      // Use the defaults: 3 retries, 1000ms base.
    });

    await expect(adapter.ingestPage(fakeConnection(), "rate-limit")).rejects.toBeInstanceOf(
      RateLimitError,
    );

    // 3 retries → 3 sleeps at 1000, 2000, 4000.
    expect(clock.calls).toEqual([1000, 2000, 4000]);
  });

  it("rate-limit retry succeeds when next attempt returns reviews (not surfaced to caller)", async () => {
    const clock = recordingClock();
    const adapter = new GoogleAdapter({ mode: "fixture", clock });

    const result = await adapter.ingestPage(fakeConnection(), "rate-limit-then-ok");

    // Caller sees the success — retry happened internally.
    expect(result.reviews).toHaveLength(5);
    // Exactly one backoff sleep happened (the first 429).
    expect(clock.calls).toEqual([1000]);
  });

  it("rate-limit retry uses the injected clock and does not actually sleep", async () => {
    const clock = recordingClock();
    const adapter = new GoogleAdapter({ mode: "fixture", clock });

    const start = Date.now();
    await expect(adapter.ingestPage(fakeConnection(), "rate-limit")).rejects.toBeInstanceOf(
      RateLimitError,
    );
    const elapsed = Date.now() - start;

    // If the real clock ran, elapsed would be ≥ 7s. We just want fast.
    expect(elapsed).toBeLessThan(500);
  });
});

describe("GoogleAdapter — subscribeForUpdates", () => {
  it("throws NotImplemented (wired in slice 10)", async () => {
    const adapter = new GoogleAdapter({ mode: "fixture" });
    await expect(adapter.subscribeForUpdates(fakeConnection())).rejects.toThrow(/NotImplemented/);
  });
});

describe("GoogleAdapter — live mode", () => {
  it("ingestPage throws NotImplemented (wired in slice 10)", async () => {
    const adapter = new GoogleAdapter({ mode: "live" });
    await expect(adapter.ingestPage(fakeConnection())).rejects.toThrow(/NotImplemented/);
  });

  it("constructor reads GOOGLE_ADAPTER_MODE=live from env", async () => {
    const prev = process.env.GOOGLE_ADAPTER_MODE;
    try {
      vi.stubEnv("GOOGLE_ADAPTER_MODE", "live");
      const adapter = new GoogleAdapter();
      await expect(adapter.ingestPage(fakeConnection())).rejects.toThrow(/NotImplemented/);
    } finally {
      if (prev === undefined) vi.unstubAllEnvs();
      else vi.stubEnv("GOOGLE_ADAPTER_MODE", prev);
    }
  });

  it("constructor defaults to fixture when env is unset / invalid", async () => {
    vi.stubEnv("GOOGLE_ADAPTER_MODE", "nonsense");
    try {
      const adapter = new GoogleAdapter();
      const result = await adapter.ingestPage(fakeConnection());
      expect(result.reviews).toHaveLength(5);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("mapGoogleReview", () => {
  it("maps Google's enum starRating to a 1..5 number", () => {
    const out = mapGoogleReview({
      reviewId: "abc",
      starRating: "THREE",
      comment: "ok",
      reviewer: { displayName: "X" },
      createTime: "2026-01-02T03:04:05Z",
    });
    expect(out.star_rating).toBe(3);
  });

  it("treats a star-only Review (no comment) as review_text=null", () => {
    const out = mapGoogleReview({
      reviewId: "abc",
      starRating: "FIVE",
      reviewer: { displayName: "Quiet" },
      createTime: "2026-01-02T03:04:05Z",
    });
    expect(out.review_text).toBeNull();
    expect(out.star_rating).toBe(5);
  });

  it("treats a missing reviewer displayName as null (anonymous Review)", () => {
    const out = mapGoogleReview({
      reviewId: "abc",
      starRating: "FOUR",
      comment: "fine",
      createTime: "2026-01-02T03:04:05Z",
    });
    expect(out.reviewer_display_name).toBeNull();
  });

  it("falls back to deriving source_review_id from `name` when reviewId is absent", () => {
    const out = mapGoogleReview({
      name: "accounts/1/locations/2/reviews/the-id",
      starRating: "FIVE",
      createTime: "2026-01-02T03:04:05Z",
    });
    expect(out.source_review_id).toBe("the-id");
  });

  it("parses RFC 3339 with fractional seconds + Z suffix", () => {
    const out = mapGoogleReview({
      reviewId: "abc",
      starRating: "FIVE",
      createTime: "2026-04-29T19:02:11.500Z",
    });
    expect(out.posted_at.toISOString()).toBe("2026-04-29T19:02:11.500Z");
  });

  it("captures updateTime and reviewReply under the typed `google` namespace", () => {
    const out = mapGoogleReview({
      reviewId: "abc",
      starRating: "TWO",
      comment: "meh",
      createTime: "2026-04-22T12:30:45Z",
      updateTime: "2026-04-23T09:00:00Z",
      reviewReply: { comment: "Sorry to hear that." },
    });
    expect(out.google?.update_time).toBe("2026-04-23T09:00:00Z");
    expect(out.google?.review_reply).toBe("Sorry to hear that.");
  });

  it("throws on a missing createTime — better than silently emitting Invalid Date", () => {
    expect(() => mapGoogleReview({ reviewId: "abc", starRating: "FIVE" })).toThrow(/createTime/);
  });

  it("throws on a missing source_review_id (no reviewId and no name)", () => {
    expect(() =>
      mapGoogleReview({
        starRating: "FIVE",
        createTime: "2026-01-02T03:04:05Z",
      }),
    ).toThrow(/source_review_id/);
  });
});
