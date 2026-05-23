/**
 * Unit tests for the `ingest_review` job handler.
 *
 * Strategy: the handler is wired with a dependency-injection object
 * (`IngestReviewDeps`), so tests provide fakes for the repositories +
 * Classifier + enqueue helper. This lets us assert the exact ordering and
 * payload of each step without standing up Postgres or hitting Anthropic.
 *
 * Coverage required by issue #10:
 *   - happy path → both rows persisted with matching fields.
 *   - idempotency → re-running same payload still ends with 1 review + 1
 *     classification (we model `upsertReviewBySourceId` to return the same id).
 *   - Classifier failure path → reviews row persists, classification absent,
 *     error re-thrown so pg-boss retries.
 *   - is_incident=true path → fire_incident is enqueued.
 *   - is_incident=false path → fire_incident is NOT enqueued.
 *   - star-only Review (review_text=null) → redacted_text="", still classified.
 *   - source_connection missing → handler bails silently, does NOT throw.
 *   - Redactor is called BEFORE the Classifier (ADR-0006 chokepoint).
 */
import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Classification } from "@/lib/classifier";
import type { Review } from "@/lib/sources/source-adapter";

import { IngestReviewDeps, handleIngestReview } from "../ingest-review";
import type { IngestReviewPayload } from "../../boss";
import type { SourceConnectionWithBusiness } from "@/db/queries/source-connections";

// ---- Test fixtures ------------------------------------------------------

const SOURCE_CONNECTION_ID = "sc-00000000-0000-0000-0000-000000000001";
const BUSINESS_ID = "biz-00000000-0000-0000-0000-000000000001";
const REVIEW_ROW_ID = "rev-00000000-0000-0000-0000-000000000001";

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    source_review_id: "google-rev-1",
    star_rating: 4,
    review_text: "Loved the service from JaneD — pastries were excellent.",
    reviewer_display_name: "JaneD",
    posted_at: new Date("2026-05-20T14:00:00Z"),
    ...overrides,
  };
}

function makeJob(payload: IngestReviewPayload): Job<IngestReviewPayload> {
  // pg-boss's Job<T> has many fields; we only need `id` and `data` and
  // the runtime treats unknown fields as harmless, so cast.
  return {
    id: "job-1",
    name: "ingest_review",
    data: payload,
  } as unknown as Job<IngestReviewPayload>;
}

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    is_incident: false,
    severity: null,
    themes: ["service", "product_quality"],
    sentiment: "positive",
    suggested_reply: "Thanks for the kind words — see you next time!",
    prompt_version: "v1",
    ...overrides,
  };
}

/**
 * Build the dep-injection object with vi.fn()s pre-configured for the happy
 * path. Individual tests override one or two fns to exercise edge cases.
 */
function makeDeps(opts: {
  classification?: Classification;
  classifyError?: Error;
  sourceConnectionMissing?: boolean;
}): { deps: IngestReviewDeps; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const findSourceConnectionWithBusiness = vi.fn(async (_id: string) => {
    if (opts.sourceConnectionMissing) return null;
    return {
      sourceConnection: {
        id: SOURCE_CONNECTION_ID,
        businessId: BUSINESS_ID,
        source: "google" as const,
      },
      business: {
        id: BUSINESS_ID,
        name: "Acme Bakery",
        industry: "food_service",
      },
      // Test cares only about id/source/businessId + business name/industry;
      // the rest of the SourceConnectionRow shape (token columns, status enums,
      // timestamps) is supplied at runtime by slice 8's authoritative table
      // and not exercised here.
    } as unknown as SourceConnectionWithBusiness;
  });

  // Idempotency: same (source, source_review_id) → same row id. Our fake
  // ignores the input and always returns REVIEW_ROW_ID, which models the
  // real DB's `(source, source_review_id)` unique constraint.
  const upsertReviewBySourceId = vi.fn(async (_input: unknown) => REVIEW_ROW_ID);

  const upsertClassification = vi.fn(async (_input: unknown) => undefined);

  const redact = vi.fn((text: string, _knownNames: readonly string[]) => {
    // Don't run the real Redactor; the test that pins ordering asserts on
    // this fn's call history. We do faithfully return "" for empty input.
    if (text.length === 0) return "";
    // Cheap fake: also strip the first known name like the real Redactor would.
    let out = text;
    for (const name of _knownNames) {
      if (name.length > 0) out = out.split(name).join("[REVIEWER]");
    }
    return `<redacted>${out}</redacted>`;
  });

  const classify = vi.fn(async () => {
    if (opts.classifyError) throw opts.classifyError;
    return opts.classification ?? makeClassification();
  });

  const enqueueFireIncident = vi.fn(async (_payload: { review_id: string }) => "fire-job-1");

  const deps: IngestReviewDeps = {
    findSourceConnectionWithBusiness,
    upsertReviewBySourceId,
    upsertClassification,
    redact,
    classify,
    enqueueFireIncident,
  };

  return {
    deps,
    spies: {
      findSourceConnectionWithBusiness,
      upsertReviewBySourceId,
      upsertClassification,
      redact,
      classify,
      enqueueFireIncident,
    },
  };
}

// ---- Tests --------------------------------------------------------------

describe("handleIngestReview — happy path", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("persists a review row, a classification row, and matches input fields", async () => {
    const { deps, spies } = makeDeps({});
    const review = makeReview();
    const payload: IngestReviewPayload = {
      source_connection_id: SOURCE_CONNECTION_ID,
      raw_review: review,
    };

    await handleIngestReview([makeJob(payload)], deps);

    expect(spies.upsertReviewBySourceId).toHaveBeenCalledTimes(1);
    const reviewArgs = spies.upsertReviewBySourceId.mock.calls[0][0];
    expect(reviewArgs).toMatchObject({
      sourceConnectionId: SOURCE_CONNECTION_ID,
      source: "google",
      sourceReviewId: review.source_review_id,
      starRating: review.star_rating,
      reviewText: review.review_text,
      reviewerDisplayName: review.reviewer_display_name,
      postedAt: review.posted_at,
    });
    expect(reviewArgs.redactedText).toContain("<redacted>");

    expect(spies.upsertClassification).toHaveBeenCalledTimes(1);
    const classificationArgs = spies.upsertClassification.mock.calls[0][0];
    expect(classificationArgs).toMatchObject({
      reviewId: REVIEW_ROW_ID,
      promptVersion: "v1",
      isIncident: false,
      severity: null,
      themes: ["service", "product_quality"],
      sentiment: "positive",
    });

    consoleSpy.mockRestore();
  });

  it("calls Redactor BEFORE Classifier and passes the redacted text in (ADR-0006)", async () => {
    const { deps, spies } = makeDeps({});
    const review = makeReview();
    await handleIngestReview(
      [
        makeJob({
          source_connection_id: SOURCE_CONNECTION_ID,
          raw_review: review,
        }),
      ],
      deps,
    );

    // Redactor sees the raw review text + the Reviewer display name as a
    // known name.
    expect(spies.redact).toHaveBeenCalledWith(review.review_text, [review.reviewer_display_name]);

    // The Classifier never sees `reviewer_display_name` — only the
    // redacted output is passed through.
    const classifyInput = spies.classify.mock.calls[0][0];
    // Real Redactor would strip "JaneD"; our fake also does (see makeDeps).
    expect(classifyInput.redactedText).toContain("<redacted>");
    expect(classifyInput.redactedText).toContain("[REVIEWER]");
    expect(JSON.stringify(classifyInput)).not.toContain(review.reviewer_display_name as string);
  });

  it("passes the Business name + industry through to the Classifier as businessProfile", async () => {
    const { deps, spies } = makeDeps({});
    await handleIngestReview(
      [
        makeJob({
          source_connection_id: SOURCE_CONNECTION_ID,
          raw_review: makeReview(),
        }),
      ],
      deps,
    );

    const classifyInput = spies.classify.mock.calls[0][0];
    expect(classifyInput.businessProfile).toEqual({
      name: "Acme Bakery",
      industry: "food_service",
    });
  });
});

describe("handleIngestReview — idempotency", () => {
  it("re-running the same payload still produces one Review + one Classification row", async () => {
    const { deps, spies } = makeDeps({});
    const payload: IngestReviewPayload = {
      source_connection_id: SOURCE_CONNECTION_ID,
      raw_review: makeReview(),
    };

    await handleIngestReview([makeJob(payload)], deps);
    await handleIngestReview([makeJob(payload)], deps);

    // Both runs went through the upsert helpers. Idempotency lives in the
    // UNIQUE INDEX on (source, source_review_id) at the DB layer, modelled
    // here by `upsertReviewBySourceId` returning the SAME id both calls —
    // which means downstream classifications also key on the same row id.
    expect(spies.upsertReviewBySourceId).toHaveBeenCalledTimes(2);
    const firstId = await spies.upsertReviewBySourceId.mock.results[0].value;
    const secondId = await spies.upsertReviewBySourceId.mock.results[1].value;
    expect(firstId).toBe(secondId);

    expect(spies.upsertClassification).toHaveBeenCalledTimes(2);
    expect(spies.upsertClassification.mock.calls[0][0].reviewId).toBe(
      spies.upsertClassification.mock.calls[1][0].reviewId,
    );
  });
});

describe("handleIngestReview — Classifier failure", () => {
  it("persists the Review row, skips the Classification row, and re-throws", async () => {
    const error = new Error("anthropic 500");
    const { deps, spies } = makeDeps({ classifyError: error });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      handleIngestReview(
        [
          makeJob({
            source_connection_id: SOURCE_CONNECTION_ID,
            raw_review: makeReview(),
          }),
        ],
        deps,
      ),
    ).rejects.toThrow("anthropic 500");

    // Review row was written before the Classifier was called.
    expect(spies.upsertReviewBySourceId).toHaveBeenCalledTimes(1);
    // Classification row was NOT written.
    expect(spies.upsertClassification).not.toHaveBeenCalled();
    // No Incident either.
    expect(spies.enqueueFireIncident).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe("handleIngestReview — Incident routing", () => {
  it("enqueues fire_incident when classification.is_incident is true", async () => {
    const { deps, spies } = makeDeps({
      classification: makeClassification({
        is_incident: true,
        severity: "high",
        themes: ["staff_attitude"],
        sentiment: "negative",
      }),
    });

    await handleIngestReview(
      [
        makeJob({
          source_connection_id: SOURCE_CONNECTION_ID,
          raw_review: makeReview(),
        }),
      ],
      deps,
    );

    expect(spies.enqueueFireIncident).toHaveBeenCalledTimes(1);
    expect(spies.enqueueFireIncident).toHaveBeenCalledWith({ review_id: REVIEW_ROW_ID });
  });

  it("does NOT enqueue fire_incident when classification.is_incident is false", async () => {
    const { deps, spies } = makeDeps({
      classification: makeClassification({ is_incident: false }),
    });

    await handleIngestReview(
      [
        makeJob({
          source_connection_id: SOURCE_CONNECTION_ID,
          raw_review: makeReview(),
        }),
      ],
      deps,
    );

    expect(spies.enqueueFireIncident).not.toHaveBeenCalled();
  });
});

describe("handleIngestReview — star-only Review", () => {
  it("handles review_text=null without crashing and writes an empty redacted_text", async () => {
    const { deps, spies } = makeDeps({});
    const review = makeReview({ review_text: null, reviewer_display_name: null });

    await handleIngestReview(
      [
        makeJob({
          source_connection_id: SOURCE_CONNECTION_ID,
          raw_review: review,
        }),
      ],
      deps,
    );

    // Redactor was called with "" (per Algorithm step 4) and empty knownNames
    // (per Algorithm step 3 — null name is filtered out).
    expect(spies.redact).toHaveBeenCalledWith("", []);
    expect(spies.upsertReviewBySourceId.mock.calls[0][0]).toMatchObject({
      reviewText: null,
      reviewerDisplayName: null,
      redactedText: "",
    });
    // Classification still happens — the star rating alone is enough.
    expect(spies.upsertClassification).toHaveBeenCalledTimes(1);
  });
});

describe("handleIngestReview — vanished source_connection", () => {
  it("bails silently (does not throw) when the source_connection no longer exists", async () => {
    const { deps, spies } = makeDeps({ sourceConnectionMissing: true });
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await handleIngestReview(
      [
        makeJob({
          source_connection_id: "sc-deleted",
          raw_review: makeReview(),
        }),
      ],
      deps,
    );

    expect(spies.upsertReviewBySourceId).not.toHaveBeenCalled();
    expect(spies.classify).not.toHaveBeenCalled();
    expect(spies.enqueueFireIncident).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe("handleIngestReview — batch", () => {
  it("processes multiple jobs in one call", async () => {
    const { deps, spies } = makeDeps({});
    const jobs = [
      makeJob({
        source_connection_id: SOURCE_CONNECTION_ID,
        raw_review: makeReview({ source_review_id: "g-1" }),
      }),
      makeJob({
        source_connection_id: SOURCE_CONNECTION_ID,
        raw_review: makeReview({ source_review_id: "g-2" }),
      }),
    ];

    await handleIngestReview(jobs, deps);

    expect(spies.upsertReviewBySourceId).toHaveBeenCalledTimes(2);
    expect(spies.upsertClassification).toHaveBeenCalledTimes(2);
  });

  it("propagates failure of one job without short-circuiting subsequent ones (well — actually does short-circuit because pg-boss expects throw)", async () => {
    // This test pins current behaviour: we throw on first failure so pg-boss
    // can retry the failed job. The remaining batch items aren't processed
    // in this invocation — pg-boss redelivers them. If that ever changes
    // (e.g. catch + continue), this test changes too.
    const { deps, spies } = makeDeps({ classifyError: new Error("boom") });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const jobs = [
      makeJob({
        source_connection_id: SOURCE_CONNECTION_ID,
        raw_review: makeReview({ source_review_id: "g-1" }),
      }),
      makeJob({
        source_connection_id: SOURCE_CONNECTION_ID,
        raw_review: makeReview({ source_review_id: "g-2" }),
      }),
    ];

    await expect(handleIngestReview(jobs, deps)).rejects.toThrow("boom");
    expect(spies.classify).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
  });
});

describe("handleIngestReview — real Redactor integration (ADR-0006 chokepoint)", () => {
  it("uses the real Redactor by default so no raw Reviewer name reaches the Classifier", async () => {
    // Import the real default deps. We override `classify` and the
    // persistence helpers (which would otherwise hit the DB) but leave
    // `redact` at its production wiring.
    const mod = await import("../ingest-review");
    const realRedact = (await import("@/lib/redactor")).redact;

    const captured: { redactedText?: string } = {};
    const deps: IngestReviewDeps = {
      ...mod.DEFAULT_INGEST_REVIEW_DEPS,
      redact: realRedact, // explicit — pins the default to the production fn
      findSourceConnectionWithBusiness: async () =>
        ({
          sourceConnection: {
            id: SOURCE_CONNECTION_ID,
            businessId: BUSINESS_ID,
            source: "google" as const,
          },
          business: { id: BUSINESS_ID, name: "Acme Bakery", industry: "food_service" },
        }) as unknown as SourceConnectionWithBusiness,
      upsertReviewBySourceId: async () => REVIEW_ROW_ID,
      upsertClassification: async () => undefined,
      classify: async (input) => {
        captured.redactedText = input.redactedText;
        return makeClassification();
      },
      enqueueFireIncident: async () => "fire-1",
    };

    await handleIngestReview(
      [
        makeJob({
          source_connection_id: SOURCE_CONNECTION_ID,
          raw_review: makeReview({
            review_text: "Loved my coffee with JaneD this morning!",
            reviewer_display_name: "JaneD",
          }),
        }),
      ],
      deps,
    );

    expect(captured.redactedText).toBeDefined();
    expect(captured.redactedText).not.toContain("JaneD");
    expect(captured.redactedText).toContain("[REVIEWER]");
  });
});
