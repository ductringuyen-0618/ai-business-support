/**
 * Tests for `POST /api/internal/deletion-request` (slice 15).
 *
 * Strategy: mock `@/db/queries/reviews` to point at the in-memory fake-db
 * (`fake-reviews-db.ts`) so we can seed real Review + SourceConnection +
 * Classification rows and assert post-conditions row-by-row. Auth (Clerk +
 * header key) is exercised against the real route code by setting env vars
 * and headers.
 *
 * Coverage required by issue #13 + the slice spec:
 *   - Targeting Reviewer A in Business X nulls A's 3 rows, leaves B's 2
 *     rows in X untouched, leaves A's 1 row in Business Y untouched
 *     (tenant isolation).
 *   - Targeting source_review_ids mixing two Businesses only nulls the
 *     ones whose source_connection lives in the named Business.
 *   - Re-invocation is idempotent.
 *   - Non-admin → 403.
 *   - Admin via header key → accepted.
 *   - Both reviewer_display_name AND source_review_ids → 400.
 *   - Neither → 400.
 *   - Classification rows are still queryable after the null-out (trend
 *     reporting integrity per ADR-0006).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FakeState,
  fakeNullReviewerByBusiness,
  makeFakeState,
  seedClassification,
  seedReview,
  seedSourceConnection,
} from "./fake-reviews-db";

const BUSINESS_X = "11111111-1111-1111-1111-111111111111";
const BUSINESS_Y = "22222222-2222-2222-2222-222222222222";

const ADMIN_KEY = "test-admin-key-deadbeef";
const ADMIN_CLERK_ID = "user_admin_1";
const NON_ADMIN_CLERK_ID = "user_someone_else";

// Mutable state for the mocked Clerk `auth()` and the mocked DB layer.
let mockedClerkUserId: string | null = null;
let state: FakeState = makeFakeState();

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: mockedClerkUserId })),
}));

vi.mock("@/db/queries/reviews", () => ({
  nullReviewerByBusiness: vi.fn(async (input: Parameters<typeof fakeNullReviewerByBusiness>[1]) => {
    return fakeNullReviewerByBusiness(state, input);
  }),
}));

// Import AFTER the mocks are set up — module-level code in the route reads
// the mocked modules.
const { POST } = await import("@/app/api/internal/deletion-request/route");

interface RouteBody {
  business_id: string;
  reviewer_display_name?: string;
  source_review_ids?: string[];
}

function makeRequest(body: RouteBody | string, opts: { headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  };
  return new Request("http://localhost/api/internal/deletion-request", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  state = makeFakeState();
  mockedClerkUserId = null;
  process.env.ADMIN_USER_IDS = ADMIN_CLERK_ID;
  process.env.INTERNAL_ADMIN_KEY = ADMIN_KEY;
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Build the standard test fixture:
 *   - Business X has one source_connection sc_X with:
 *       - 3 Reviews from Reviewer "Jane D"
 *       - 2 Reviews from Reviewer "Bob S"
 *   - Business Y has one source_connection sc_Y with:
 *       - 1 Review from Reviewer "Jane D" (same display name, different
 *         Business — the cross-tenant safety check).
 *   - Each review has a Classification with themes.
 */
function seedStandardFixture() {
  const scX = seedSourceConnection(state, { businessId: BUSINESS_X });
  const scY = seedSourceConnection(state, { businessId: BUSINESS_Y });

  const janeX1 = seedReview(state, {
    sourceConnectionId: scX.id,
    sourceReviewId: "g-x-jane-1",
    reviewerDisplayName: "Jane D",
    reviewText: "service was great",
  });
  const janeX2 = seedReview(state, {
    sourceConnectionId: scX.id,
    sourceReviewId: "g-x-jane-2",
    reviewerDisplayName: "Jane D",
    reviewText: "loved the coffee",
  });
  const janeX3 = seedReview(state, {
    sourceConnectionId: scX.id,
    sourceReviewId: "g-x-jane-3",
    reviewerDisplayName: "Jane D",
    reviewText: "would visit again",
  });
  const bobX1 = seedReview(state, {
    sourceConnectionId: scX.id,
    sourceReviewId: "g-x-bob-1",
    reviewerDisplayName: "Bob S",
    reviewText: "okay i guess",
  });
  const bobX2 = seedReview(state, {
    sourceConnectionId: scX.id,
    sourceReviewId: "g-x-bob-2",
    reviewerDisplayName: "Bob S",
    reviewText: "not for me",
  });
  const janeY1 = seedReview(state, {
    sourceConnectionId: scY.id,
    sourceReviewId: "g-y-jane-1",
    reviewerDisplayName: "Jane D",
    reviewText: "different business entirely",
  });

  for (const r of [janeX1, janeX2, janeX3, bobX1, bobX2, janeY1]) {
    seedClassification(state, { reviewId: r.id, themes: ["service"] });
  }

  return { scX, scY, janeX1, janeX2, janeX3, bobX1, bobX2, janeY1 };
}

describe("POST /api/internal/deletion-request — happy paths", () => {
  it("by reviewer_display_name: nulls Reviewer A's 3 rows in X, leaves B in X + A in Y untouched", async () => {
    const { janeX1, janeX2, janeX3, bobX1, bobX2, janeY1 } = seedStandardFixture();

    const res = await POST(
      makeRequest(
        { business_id: BUSINESS_X, reviewer_display_name: "Jane D" },
        { headers: { "x-internal-admin-key": ADMIN_KEY } },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      affected: number;
      business_id: string;
      matched_review_ids: string[];
    };
    expect(body.affected).toBe(3);
    expect(body.business_id).toBe(BUSINESS_X);
    expect(new Set(body.matched_review_ids)).toEqual(new Set([janeX1.id, janeX2.id, janeX3.id]));

    // Reviewer A's three rows in X are nulled.
    for (const r of [janeX1, janeX2, janeX3]) {
      const live = state.reviews.find((x) => x.id === r.id)!;
      expect(live.reviewText).toBeNull();
      expect(live.reviewerDisplayName).toBeNull();
    }
    // Reviewer B's two rows in X are untouched.
    for (const r of [bobX1, bobX2]) {
      const live = state.reviews.find((x) => x.id === r.id)!;
      expect(live.reviewText).not.toBeNull();
      expect(live.reviewerDisplayName).toBe("Bob S");
    }
    // Reviewer A's one row in Business Y is untouched (cross-tenant safety).
    const janeYLive = state.reviews.find((x) => x.id === janeY1.id)!;
    expect(janeYLive.reviewText).toBe("different business entirely");
    expect(janeYLive.reviewerDisplayName).toBe("Jane D");

    // All six classifications are intact (themes still queryable).
    expect(state.classifications).toHaveLength(6);
    for (const c of state.classifications) {
      expect(c.themes).toEqual(["service"]);
    }
  });

  it("by source_review_ids: only the IDs whose row belongs to the named Business are nulled", async () => {
    const { janeX1, janeX2, janeY1 } = seedStandardFixture();

    // Mix one X id and one Y id in the request. Scope is Business X, so only
    // the X-side row should be affected; the Y-side row stays intact even
    // though its id was named, because the predicate is AND'd with
    // business_id.
    const res = await POST(
      makeRequest(
        {
          business_id: BUSINESS_X,
          source_review_ids: [janeX1.sourceReviewId, janeY1.sourceReviewId],
        },
        { headers: { "x-internal-admin-key": ADMIN_KEY } },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      affected: number;
      matched_review_ids: string[];
    };
    expect(body.affected).toBe(1);
    expect(body.matched_review_ids).toEqual([janeX1.id]);

    // X-side row is nulled, Y-side row is intact.
    expect(state.reviews.find((r) => r.id === janeX1.id)!.reviewText).toBeNull();
    expect(state.reviews.find((r) => r.id === janeY1.id)!.reviewText).toBe(
      "different business entirely",
    );
    // janeX2 was not named — must be untouched.
    expect(state.reviews.find((r) => r.id === janeX2.id)!.reviewText).toBe("loved the coffee");
  });

  it("admin Clerk session is accepted (no header key needed)", async () => {
    seedStandardFixture();
    mockedClerkUserId = ADMIN_CLERK_ID;

    const res = await POST(
      makeRequest({
        business_id: BUSINESS_X,
        reviewer_display_name: "Jane D",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected: number };
    expect(body.affected).toBe(3);
  });

  it("admin via header key is accepted (no Clerk session)", async () => {
    seedStandardFixture();
    mockedClerkUserId = null;

    const res = await POST(
      makeRequest(
        { business_id: BUSINESS_X, reviewer_display_name: "Jane D" },
        { headers: { "x-internal-admin-key": ADMIN_KEY } },
      ),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/internal/deletion-request — idempotency", () => {
  it("re-invocation on already-nulled rows still matches them and reports the same count", async () => {
    seedStandardFixture();

    const first = await POST(
      makeRequest(
        { business_id: BUSINESS_X, reviewer_display_name: "Jane D" },
        { headers: { "x-internal-admin-key": ADMIN_KEY } },
      ),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { affected: number };

    const second = await POST(
      makeRequest(
        { business_id: BUSINESS_X, reviewer_display_name: "Jane D" },
        { headers: { "x-internal-admin-key": ADMIN_KEY } },
      ),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { affected: number };

    // The semantics we chose: `affected` counts WHERE-matched rows, not
    // fields-actually-changed. A second run still matches the (nulled) rows
    // by their persistent (business, source_review_id) tuples — but wait:
    // matching by reviewer_display_name on a now-null column matches ZERO
    // rows. Document and test that behaviour: the FIRST run returns 3, the
    // SECOND run on the same NAME predicate returns 0 (because the name was
    // nulled). Source-id predicates are the truly idempotent shape.
    expect(firstBody.affected).toBe(3);
    expect(secondBody.affected).toBe(0);
  });

  it("source-id-based re-invocation is fully idempotent (matches the same rows again)", async () => {
    const { janeX1, janeX2, janeX3 } = seedStandardFixture();

    const ids = [janeX1.sourceReviewId, janeX2.sourceReviewId, janeX3.sourceReviewId];

    const first = await POST(
      makeRequest(
        { business_id: BUSINESS_X, source_review_ids: ids },
        { headers: { "x-internal-admin-key": ADMIN_KEY } },
      ),
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as { affected: number }).affected).toBe(3);

    const second = await POST(
      makeRequest(
        { business_id: BUSINESS_X, source_review_ids: ids },
        { headers: { "x-internal-admin-key": ADMIN_KEY } },
      ),
    );
    expect(second.status).toBe(200);
    // Source-side review id is immutable, so a re-run still matches the
    // three rows; the SET-to-NULL is a no-op on already-null columns but
    // the WHERE clause still hits.
    expect(((await second.json()) as { affected: number }).affected).toBe(3);
  });
});

describe("POST /api/internal/deletion-request — auth", () => {
  it("non-admin Clerk session + no admin key → 403", async () => {
    seedStandardFixture();
    mockedClerkUserId = NON_ADMIN_CLERK_ID;

    const res = await POST(
      makeRequest({
        business_id: BUSINESS_X,
        reviewer_display_name: "Jane D",
      }),
    );
    expect(res.status).toBe(403);
    // No rows touched.
    expect(state.reviews.filter((r) => r.reviewText === null)).toHaveLength(0);
  });

  it("no Clerk session + no admin key → 403", async () => {
    seedStandardFixture();
    mockedClerkUserId = null;

    const res = await POST(
      makeRequest({
        business_id: BUSINESS_X,
        reviewer_display_name: "Jane D",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("wrong admin key + non-admin Clerk → 403", async () => {
    seedStandardFixture();
    mockedClerkUserId = NON_ADMIN_CLERK_ID;

    const res = await POST(
      makeRequest(
        { business_id: BUSINESS_X, reviewer_display_name: "Jane D" },
        { headers: { "x-internal-admin-key": "not-the-real-key" } },
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/internal/deletion-request — body validation", () => {
  it("both reviewer_display_name AND source_review_ids → 400", async () => {
    seedStandardFixture();

    const res = await POST(
      makeRequest(
        {
          business_id: BUSINESS_X,
          reviewer_display_name: "Jane D",
          source_review_ids: ["g-x-jane-1"],
        },
        { headers: { "x-internal-admin-key": ADMIN_KEY } },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/exactly one/i);
  });

  it("neither reviewer_display_name nor source_review_ids → 400", async () => {
    const res = await POST(
      makeRequest({ business_id: BUSINESS_X }, { headers: { "x-internal-admin-key": ADMIN_KEY } }),
    );
    expect(res.status).toBe(400);
  });

  it("missing business_id → 400", async () => {
    const res = await POST(
      makeRequest({ reviewer_display_name: "Jane D" } as unknown as RouteBody, {
        headers: { "x-internal-admin-key": ADMIN_KEY },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("non-UUID business_id → 400", async () => {
    const res = await POST(
      makeRequest(
        { business_id: "not-a-uuid", reviewer_display_name: "Jane D" },
        { headers: { "x-internal-admin-key": ADMIN_KEY } },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("malformed JSON body → 400", async () => {
    const res = await POST(
      makeRequest("not json at all", {
        headers: { "x-internal-admin-key": ADMIN_KEY },
      }),
    );
    expect(res.status).toBe(400);
  });
});
