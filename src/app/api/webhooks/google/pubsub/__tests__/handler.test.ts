/**
 * Unit tests for the Pub/Sub webhook handler (slice 10).
 *
 * We test the pure handler rather than the route — same pattern slice 8
 * uses for OAuth callback. The route is a 7-line adapter and exercising it
 * adds no real coverage on top of these.
 *
 * Required coverage from the slice spec:
 *   - Missing token: 401.
 *   - Valid token via header: ok.
 *   - Valid token via query param (fallback): ok.
 *   - Re-delivery of same message_id: still ok, only one ledger insert.
 *   - Malformed envelope: 400.
 *   - Valid payload → enqueues `ingest_review` job(s).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceConnectionRow } from "@/db/schema";
import type { Review, SourceAdapter, SourceConnection } from "@/lib/sources/source-adapter";

import { handleGooglePubsub, type PubsubHandlerDeps } from "../handler";

const EXPECTED_TOKEN = "pubsub-secret-xyz";
const SOURCE_CONNECTION_ID = "sc-pubsub-0000-0000-0000-000000000010";
const LOCATION_ID = "loc-12345";

function makeRow(overrides: Partial<SourceConnectionRow> = {}): SourceConnectionRow {
  return {
    id: SOURCE_CONNECTION_ID,
    businessId: "biz-1",
    source: "google",
    oauthAccessToken: null,
    oauthRefreshToken: null,
    oauthExpiresAt: null,
    status: "healthy",
    backfillStatus: "complete",
    loadedCount: 0,
    estimatedTotal: null,
    createdAt: new Date(),
    disconnectedAt: null,
    googleLocationId: LOCATION_ID,
    readyEmailSentAt: null,
    ...overrides,
  };
}

function makeAdapter(reviews: Review[]): SourceAdapter {
  return {
    ingestPage: async (_c: SourceConnection) => ({ reviews }),
    subscribeForUpdates: async () => undefined,
  };
}

function fakeReview(idSuffix: string): Review {
  return {
    source_review_id: `g-${idSuffix}`,
    star_rating: 4,
    review_text: "Pub/Sub fresh review",
    reviewer_display_name: "Pat",
    posted_at: new Date("2026-05-22T10:00:00Z"),
  };
}

function encodeData(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

function makeEnvelope(opts: {
  messageId?: string;
  data?: string;
  locationId?: string;
  notificationType?: string;
}): string {
  const data =
    opts.data ??
    encodeData({
      locationId: opts.locationId ?? LOCATION_ID,
      accountId: "acc-1",
      notificationType: opts.notificationType ?? "NEW_REVIEW",
    });
  return JSON.stringify({
    message: {
      messageId: opts.messageId ?? "pubsub-msg-1",
      publishTime: "2026-05-22T10:00:01Z",
      data,
    },
    subscription: "projects/x/subscriptions/y",
  });
}

interface DepsOpts {
  recordResult?: boolean | ((id: string) => boolean);
  connection?: SourceConnectionRow | null;
  reviews?: Review[];
  /** Pass `null` to simulate the server having no token configured. */
  expectedToken?: string | null;
}

function makeDeps(opts: DepsOpts = {}): {
  deps: PubsubHandlerDeps;
  spies: Record<string, ReturnType<typeof vi.fn>>;
} {
  const seen = new Set<string>();
  const recordProcessedPubsubMessage = vi.fn(async (id: string) => {
    if (typeof opts.recordResult === "function") return opts.recordResult(id);
    if (opts.recordResult === false) return false;
    if (opts.recordResult === true) return true;
    // Default: first time → true; subsequent → false (real ledger behaviour).
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const getSourceConnectionByGoogleLocationId = vi.fn(async (_locationId: string) =>
    opts.connection === undefined ? makeRow() : opts.connection,
  );

  const enqueueIngestReview = vi.fn(async (_payload: unknown) => "job-1");

  const adapter = makeAdapter(opts.reviews ?? [fakeReview("a"), fakeReview("b")]);

  const deps: PubsubHandlerDeps = {
    recordProcessedPubsubMessage,
    getSourceConnectionByGoogleLocationId,
    enqueueIngestReview,
    buildAdapter: () => adapter,
    expectedToken: () => {
      if (opts.expectedToken === undefined) return EXPECTED_TOKEN;
      return opts.expectedToken ?? undefined;
    },
  };

  return {
    deps,
    spies: {
      recordProcessedPubsubMessage,
      getSourceConnectionByGoogleLocationId,
      enqueueIngestReview,
    },
  };
}

// ---- Tests --------------------------------------------------------------

describe("handleGooglePubsub — authorisation", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("rejects with 'unauthorized' when no token is presented", async () => {
    const { deps, spies } = makeDeps();
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: null,
        tokenQuery: null,
        rawBody: makeEnvelope({}),
      },
      deps,
    );
    expect(outcome).toEqual({ kind: "unauthorized" });
    expect(spies.recordProcessedPubsubMessage).not.toHaveBeenCalled();
    expect(spies.enqueueIngestReview).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("rejects with 'unauthorized' when the token is wrong", async () => {
    const { deps } = makeDeps();
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: "Bearer not-the-right-token",
        tokenQuery: null,
        rawBody: makeEnvelope({}),
      },
      deps,
    );
    expect(outcome).toEqual({ kind: "unauthorized" });
  });

  it("rejects with 'unauthorized' when the server has no expected token configured", async () => {
    const { deps } = makeDeps({ expectedToken: null });
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: makeEnvelope({}),
      },
      deps,
    );
    expect(outcome).toEqual({ kind: "unauthorized" });
  });

  it("accepts a valid token via the Authorization: Bearer header", async () => {
    const { deps, spies } = makeDeps();
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: makeEnvelope({}),
      },
      deps,
    );
    expect(outcome.kind).toBe("ok");
    expect(spies.enqueueIngestReview).toHaveBeenCalledTimes(2);
  });

  it("accepts a valid token via the ?token=... query param (fallback)", async () => {
    const { deps, spies } = makeDeps();
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: null,
        tokenQuery: EXPECTED_TOKEN,
        rawBody: makeEnvelope({}),
      },
      deps,
    );
    expect(outcome.kind).toBe("ok");
    expect(spies.enqueueIngestReview).toHaveBeenCalled();
  });

  it("prefers the header when both header and query token are present", async () => {
    const { deps } = makeDeps();
    // Header carries the wrong value → outcome must be unauthorized even
    // though the query param is correct. Pinning the precedence rule.
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: "Bearer nope",
        tokenQuery: EXPECTED_TOKEN,
        rawBody: makeEnvelope({}),
      },
      deps,
    );
    expect(outcome).toEqual({ kind: "unauthorized" });
  });
});

describe("handleGooglePubsub — idempotency", () => {
  it("re-delivery of the same messageId is a no-op duplicate; only one ledger insert", async () => {
    const { deps, spies } = makeDeps();
    const body = makeEnvelope({ messageId: "msg-dedup" });

    const first = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: body,
      },
      deps,
    );
    expect(first.kind).toBe("ok");
    expect(spies.enqueueIngestReview).toHaveBeenCalledTimes(2);

    const second = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: body,
      },
      deps,
    );
    expect(second).toEqual({ kind: "duplicate", messageId: "msg-dedup" });
    // No additional enqueues from the re-delivery.
    expect(spies.enqueueIngestReview).toHaveBeenCalledTimes(2);
    expect(spies.recordProcessedPubsubMessage).toHaveBeenCalledTimes(2);
  });
});

describe("handleGooglePubsub — payload parsing", () => {
  it("returns bad_request when the envelope JSON is unparseable", async () => {
    const { deps, spies } = makeDeps();
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: "{not-json",
      },
      deps,
    );
    expect(outcome).toEqual({ kind: "bad_request", reason: "invalid_json" });
    expect(spies.recordProcessedPubsubMessage).not.toHaveBeenCalled();
  });

  it("returns bad_request when message.messageId is missing", async () => {
    const { deps } = makeDeps();
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: JSON.stringify({ message: { data: encodeData({ locationId: LOCATION_ID }) } }),
      },
      deps,
    );
    expect(outcome.kind).toBe("bad_request");
  });

  it("returns bad_request when the inner data is not valid base64-JSON", async () => {
    const { deps } = makeDeps();
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: JSON.stringify({
          message: { messageId: "m1", data: Buffer.from("not-json").toString("base64") },
        }),
      },
      deps,
    );
    expect(outcome).toEqual({ kind: "bad_request", reason: "invalid_inner_payload" });
  });

  it("returns bad_request when locationId is missing from the inner payload", async () => {
    const { deps } = makeDeps();
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: JSON.stringify({
          message: {
            messageId: "m1",
            data: encodeData({ accountId: "a1", notificationType: "NEW_REVIEW" }),
          },
        }),
      },
      deps,
    );
    expect(outcome).toEqual({ kind: "bad_request", reason: "missing_location_id" });
  });
});

describe("handleGooglePubsub — successful enqueue path", () => {
  it("enqueues one ingest_review per Review the adapter returns", async () => {
    const reviews = [fakeReview("x"), fakeReview("y"), fakeReview("z")];
    const { deps, spies } = makeDeps({ reviews });

    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: makeEnvelope({}),
      },
      deps,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.enqueued).toBe(3);

    expect(spies.enqueueIngestReview).toHaveBeenCalledTimes(3);
    for (const call of spies.enqueueIngestReview.mock.calls) {
      expect(call[0]).toMatchObject({ source_connection_id: SOURCE_CONNECTION_ID });
    }
  });

  it("returns no_match when no SourceConnection is linked to the locationId", async () => {
    const { deps, spies } = makeDeps({ connection: null });
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: makeEnvelope({}),
      },
      deps,
    );
    expect(outcome.kind).toBe("no_match");
    expect(spies.enqueueIngestReview).not.toHaveBeenCalled();
  });

  it("returns no_match when the connection is not healthy (errored / disconnected)", async () => {
    const { deps, spies } = makeDeps({ connection: makeRow({ status: "errored" }) });
    const outcome = await handleGooglePubsub(
      {
        authorizationHeader: `Bearer ${EXPECTED_TOKEN}`,
        tokenQuery: null,
        rawBody: makeEnvelope({}),
      },
      deps,
    );
    expect(outcome.kind).toBe("no_match");
    expect(spies.enqueueIngestReview).not.toHaveBeenCalled();
  });
});
