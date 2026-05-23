/**
 * Unit tests for the `backfill_source` job handler (slice 10).
 *
 * Strategy mirrors the slice-9 `ingest_review` tests: the handler is wired
 * with a dependency-injection object, so we feed fakes for the adapter,
 * DB writers, enqueue helpers, and the Resend client. This lets us assert
 * the exact ordering and payload of every side-effect — page-by-page
 * progress updates, the >=95% gate on the "ready" email, the
 * TokenExpiredError → status='errored' branch — without hitting the network.
 *
 * Required coverage from the slice spec:
 *   - Happy path: 12 Reviews → 12 ingest_review enqueues, loaded_count=12,
 *     estimated_total=12, backfill_status='complete', ready email sent once.
 *   - Multi-page: each page updates loaded_count progressively.
 *   - Re-run after completion: ready email NOT re-sent (markReadyEmailSent
 *     returns null on the second pass).
 *   - TokenExpiredError on page 1: status='errored', no throw.
 *   - RateLimitError on page 2: throws → pg-boss retries.
 *   - Empty profile: status='complete', NO ready email sent.
 */
import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceConnectionRow } from "@/db/schema";
import type { SourceConnectionWithBusiness } from "@/db/queries/source-connections";
import {
  RateLimitError,
  TokenExpiredError,
  type IngestPage,
  type Review,
  type SourceAdapter,
  type SourceConnection as InMemorySourceConnection,
} from "@/lib/sources/source-adapter";

import type { BackfillSourcePayload } from "../../boss";
import { BackfillSourceDeps, handleBackfillSource } from "../backfill-source";

// ---- Fixtures -----------------------------------------------------------

const SOURCE_CONNECTION_ID = "sc-00000000-0000-0000-0000-000000000010";
const BUSINESS_ID = "biz-00000000-0000-0000-0000-000000000010";

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    source_review_id: `g-rev-${Math.random().toString(36).slice(2, 8)}`,
    star_rating: 5,
    review_text: "Loved it.",
    reviewer_display_name: "Anonymous",
    posted_at: new Date("2026-05-20T14:00:00Z"),
    ...overrides,
  };
}

function makeJob(payload: BackfillSourcePayload): Job<BackfillSourcePayload> {
  return {
    id: "job-bf-1",
    name: "backfill_source",
    data: payload,
  } as unknown as Job<BackfillSourcePayload>;
}

function makeSourceConnectionRow(
  overrides: Partial<SourceConnectionRow> = {},
): SourceConnectionRow {
  return {
    id: SOURCE_CONNECTION_ID,
    businessId: BUSINESS_ID,
    source: "google",
    oauthAccessToken: null,
    oauthRefreshToken: null,
    oauthExpiresAt: null,
    status: "healthy",
    backfillStatus: "pending",
    loadedCount: 0,
    estimatedTotal: null,
    createdAt: new Date(),
    disconnectedAt: null,
    googleLocationId: null,
    readyEmailSentAt: null,
    ...overrides,
  };
}

function makeJoined(overrides: Partial<SourceConnectionRow> = {}): SourceConnectionWithBusiness {
  return {
    sourceConnection: makeSourceConnectionRow(overrides),
    business: {
      id: BUSINESS_ID,
      clerkOrgId: "org_acme",
      name: "Acme Bakery",
      industry: "food_service",
      createdAt: new Date(),
      cancelledAt: null,
    },
  };
}

/**
 * Build a fake SourceAdapter from a list of pages. Each call to ingestPage
 * pops the next page; the last page returns no nextPageToken. If a page is
 * an `Error` instance, it is thrown instead of returned.
 */
function makeAdapter(pages: Array<IngestPage | Error>): {
  adapter: SourceAdapter;
  calls: Array<{ pageToken: string | undefined }>;
} {
  const calls: Array<{ pageToken: string | undefined }> = [];
  let cursor = 0;
  const adapter: SourceAdapter = {
    ingestPage: async (_connection: InMemorySourceConnection, pageToken?: string) => {
      calls.push({ pageToken });
      const next = pages[cursor++];
      if (!next) {
        throw new Error(`fake adapter: no more pages (cursor=${cursor})`);
      }
      if (next instanceof Error) throw next;
      return next;
    },
    subscribeForUpdates: async () => undefined,
  };
  return { adapter, calls };
}

interface MakeDepsOpts {
  joined?: SourceConnectionWithBusiness | null;
  pages?: Array<IngestPage | Error>;
  markReadyResult?: SourceConnectionRow | null;
  sendThrows?: Error;
}

function makeDeps(opts: MakeDepsOpts = {}): {
  deps: BackfillSourceDeps;
  spies: Record<string, ReturnType<typeof vi.fn>>;
  adapterCalls: Array<{ pageToken: string | undefined }>;
} {
  const joined = opts.joined === undefined ? makeJoined() : opts.joined;
  const { adapter, calls: adapterCalls } = makeAdapter(opts.pages ?? []);

  const findSourceConnectionWithBusiness = vi.fn(async (_id: string) => joined);
  const updateBackfillProgress = vi.fn(async (_input: unknown) => null);

  // Default: this IS the first time the email fires, so the atomic flag-flip
  // returns a row. Tests that exercise the re-run path override to null.
  const markReadyEmailSent = vi.fn(async (_id: string) =>
    opts.markReadyResult === undefined ? makeSourceConnectionRow() : opts.markReadyResult,
  );

  const listActiveOperatorsForBusiness = vi.fn(async (_businessId: string) => [
    {
      id: "op-1",
      clerkUserId: "user_1",
      businessId: BUSINESS_ID,
      email: "alice@acme.test",
      name: "Alice",
      createdAt: new Date(),
      deletedAt: null,
    },
  ]);
  const enqueueIngestReview = vi.fn(async (_payload: unknown) => "job-id");
  const sendBackfillReadyEmail = vi.fn(async () => {
    if (opts.sendThrows) throw opts.sendThrows;
  });

  const deps: BackfillSourceDeps = {
    findSourceConnectionWithBusiness,
    updateBackfillProgress,
    markReadyEmailSent,
    listActiveOperatorsForBusiness,
    enqueueIngestReview,
    sendBackfillReadyEmail,
    buildAdapter: () => adapter,
    buildInMemoryConnection: () => ({
      id: SOURCE_CONNECTION_ID,
      source: "google",
      oauth_access_token: "fake-access",
      oauth_refresh_token: "fake-refresh",
    }),
  };

  return {
    deps,
    spies: {
      findSourceConnectionWithBusiness,
      updateBackfillProgress,
      markReadyEmailSent,
      listActiveOperatorsForBusiness,
      enqueueIngestReview,
      sendBackfillReadyEmail,
    },
    adapterCalls,
  };
}

// ---- Tests --------------------------------------------------------------

describe("handleBackfillSource — happy path (single page, 12 Reviews)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("enqueues 12 ingest_reviews, sets backfill_status='complete', sends ready email once", async () => {
    const twelveReviews = Array.from({ length: 12 }, (_, i) =>
      makeReview({ source_review_id: `g-${i}` }),
    );
    const { deps, spies } = makeDeps({ pages: [{ reviews: twelveReviews }] });

    await handleBackfillSource([makeJob({ source_connection_id: SOURCE_CONNECTION_ID })], deps);

    // 12 ingest_review enqueues, each carrying the source_connection_id.
    expect(spies.enqueueIngestReview).toHaveBeenCalledTimes(12);
    for (const call of spies.enqueueIngestReview.mock.calls) {
      expect(call[0]).toMatchObject({ source_connection_id: SOURCE_CONNECTION_ID });
    }

    // Progress writes: 'running' first, then per-page (here: just one page) → loaded=12, then 'complete'.
    const updates = spies.updateBackfillProgress.mock.calls.map((c) => c[0]);
    expect(updates[0]).toMatchObject({ backfillStatus: "running" });
    expect(updates).toContainEqual(
      expect.objectContaining({ loadedCount: 12, estimatedTotal: 12 }),
    );
    expect(updates[updates.length - 1]).toMatchObject({ backfillStatus: "complete" });

    // Ready email gate flips and the send happens exactly once.
    expect(spies.markReadyEmailSent).toHaveBeenCalledTimes(1);
    expect(spies.sendBackfillReadyEmail).toHaveBeenCalledTimes(1);
    const sendArgs = spies.sendBackfillReadyEmail.mock.calls[0][0];
    expect(sendArgs).toMatchObject({
      to: ["alice@acme.test"],
      businessName: "Acme Bakery",
      reviewCount: 12,
    });

    consoleSpy.mockRestore();
  });
});

describe("handleBackfillSource — multi-page progress", () => {
  it("updates loaded_count progressively per page", async () => {
    const { deps, spies, adapterCalls } = makeDeps({
      pages: [
        { reviews: [makeReview(), makeReview()], nextPageToken: "p2" },
        { reviews: [makeReview(), makeReview()], nextPageToken: "p3" },
        { reviews: [makeReview()] },
      ],
    });

    await handleBackfillSource([makeJob({ source_connection_id: SOURCE_CONNECTION_ID })], deps);

    // 3 pages → 5 enqueues.
    expect(spies.enqueueIngestReview).toHaveBeenCalledTimes(5);

    // Pagination fed nextPageToken back into ingestPage in order.
    expect(adapterCalls).toEqual([
      { pageToken: undefined },
      { pageToken: "p2" },
      { pageToken: "p3" },
    ]);

    // Per-page progress writes: loaded_count of 2, 4, 5 in order.
    const progressUpdates = spies.updateBackfillProgress.mock.calls
      .map((c) => c[0])
      .filter((u: { loadedCount?: number }) => u.loadedCount !== undefined);
    expect(progressUpdates.map((u: { loadedCount: number }) => u.loadedCount)).toEqual([2, 4, 5]);

    // Final 'complete' write.
    const last = spies.updateBackfillProgress.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ backfillStatus: "complete" });
  });
});

describe("handleBackfillSource — re-run after completion", () => {
  it("does NOT send the ready email again when ready_email_sent_at is already set", async () => {
    // Two ways the re-run is blocked: the joined row already has
    // readyEmailSentAt set (early return), or markReadyEmailSent's atomic
    // update finds the row already flagged (returns null). We test the row-
    // already-flagged path because that's the production path on a re-run.
    const joined = makeJoined({ readyEmailSentAt: new Date("2026-05-01T00:00:00Z") });
    const { deps, spies } = makeDeps({
      joined,
      pages: [{ reviews: [makeReview(), makeReview(), makeReview()] }],
    });

    await handleBackfillSource([makeJob({ source_connection_id: SOURCE_CONNECTION_ID })], deps);

    expect(spies.markReadyEmailSent).not.toHaveBeenCalled();
    expect(spies.sendBackfillReadyEmail).not.toHaveBeenCalled();
  });

  it("does NOT send the ready email when another worker won the atomic flip", async () => {
    // markReadyEmailSent returns null → handler must NOT send.
    const { deps, spies } = makeDeps({
      pages: [{ reviews: [makeReview(), makeReview(), makeReview()] }],
      markReadyResult: null,
    });

    await handleBackfillSource([makeJob({ source_connection_id: SOURCE_CONNECTION_ID })], deps);

    expect(spies.markReadyEmailSent).toHaveBeenCalledTimes(1);
    expect(spies.sendBackfillReadyEmail).not.toHaveBeenCalled();
  });
});

describe("handleBackfillSource — TokenExpiredError on page 1", () => {
  it("flips status='errored' and does NOT throw", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, spies } = makeDeps({
      pages: [new TokenExpiredError("token gone")],
    });

    await expect(
      handleBackfillSource([makeJob({ source_connection_id: SOURCE_CONNECTION_ID })], deps),
    ).resolves.toBeUndefined();

    const updates = spies.updateBackfillProgress.mock.calls.map((c) => c[0]);
    expect(updates).toContainEqual(expect.objectContaining({ status: "errored" }));
    // We do NOT mark backfill_status='failed' — the re-auth flow resumes.
    expect(updates.every((u: { backfillStatus?: string }) => u.backfillStatus !== "failed")).toBe(
      true,
    );
    expect(spies.enqueueIngestReview).not.toHaveBeenCalled();
    expect(spies.sendBackfillReadyEmail).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe("handleBackfillSource — RateLimitError on page 2", () => {
  it("re-throws so pg-boss retries; partial progress already persisted", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, spies } = makeDeps({
      pages: [
        { reviews: [makeReview(), makeReview()], nextPageToken: "p2" },
        new RateLimitError("slow down"),
      ],
    });

    await expect(
      handleBackfillSource([makeJob({ source_connection_id: SOURCE_CONNECTION_ID })], deps),
    ).rejects.toBeInstanceOf(RateLimitError);

    // The 2 Reviews from page 1 were already enqueued before the failure.
    expect(spies.enqueueIngestReview).toHaveBeenCalledTimes(2);
    // We did NOT mark complete or failed — pg-boss will retry.
    const finalUpdates = spies.updateBackfillProgress.mock.calls.map((c) => c[0]);
    expect(
      finalUpdates.every((u: { backfillStatus?: string }) => u.backfillStatus !== "complete"),
    ).toBe(true);
    expect(
      finalUpdates.every((u: { backfillStatus?: string }) => u.backfillStatus !== "failed"),
    ).toBe(true);

    consoleSpy.mockRestore();
  });
});

describe("handleBackfillSource — empty profile", () => {
  it("completes without sending the ready email", async () => {
    const { deps, spies } = makeDeps({ pages: [{ reviews: [] }] });

    await handleBackfillSource([makeJob({ source_connection_id: SOURCE_CONNECTION_ID })], deps);

    expect(spies.enqueueIngestReview).not.toHaveBeenCalled();
    const last = spies.updateBackfillProgress.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ backfillStatus: "complete" });
    // Empty profile → "nothing to be ready about".
    expect(spies.markReadyEmailSent).not.toHaveBeenCalled();
    expect(spies.sendBackfillReadyEmail).not.toHaveBeenCalled();
  });
});

describe("handleBackfillSource — guard branches", () => {
  it("bails silently when the source_connection no longer exists", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, spies } = makeDeps({ joined: null });

    await handleBackfillSource([makeJob({ source_connection_id: "sc-deleted" })], deps);

    expect(spies.enqueueIngestReview).not.toHaveBeenCalled();
    expect(spies.updateBackfillProgress).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("marks backfill_status='failed' immediately when status is not healthy", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, spies } = makeDeps({
      joined: makeJoined({ status: "errored" }),
    });

    await handleBackfillSource([makeJob({ source_connection_id: SOURCE_CONNECTION_ID })], deps);

    const updates = spies.updateBackfillProgress.mock.calls.map((c) => c[0]);
    expect(updates).toEqual([expect.objectContaining({ backfillStatus: "failed" })]);
    expect(spies.enqueueIngestReview).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("handleBackfillSource — Resend send failure is non-fatal", () => {
  it("swallows the send error after marking the row as sent (one-shot semantics preserved)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, spies } = makeDeps({
      pages: [{ reviews: [makeReview(), makeReview(), makeReview()] }],
      sendThrows: new Error("Resend 503"),
    });

    await expect(
      handleBackfillSource([makeJob({ source_connection_id: SOURCE_CONNECTION_ID })], deps),
    ).resolves.toBeUndefined();

    expect(spies.markReadyEmailSent).toHaveBeenCalledTimes(1);
    expect(spies.sendBackfillReadyEmail).toHaveBeenCalledTimes(1);
    // Final state still 'complete'.
    const last = spies.updateBackfillProgress.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ backfillStatus: "complete" });
    consoleSpy.mockRestore();
  });
});
