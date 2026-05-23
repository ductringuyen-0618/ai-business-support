/**
 * Unit tests for the `compose_digest` job handler + the hourly enqueuer.
 *
 * Strategy mirrors `fire-incident.test.ts`: inject DB + compose + send fakes
 * via the Deps seam and assert on call counts/payloads.
 *
 * Coverage required by issue #16:
 *   - Skip if < 1 Review in the current window — NO Digest row, NO email.
 *   - Persist Digest row before sending email.
 *   - Send one email per active Operator at the Business with the right subject.
 *   - The Monday-08:00-per-timezone enqueuer skips Businesses whose local
 *     clock isn't currently Monday 08:00.
 *   - The enqueuer emits a `compose_digest` job for Businesses whose local
 *     clock IS Monday 08:00 (idempotency comes from the singletonKey, which
 *     is asserted on its own).
 */
import type { Job } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import type { Business, DigestBody } from "@/db/schema";
import type { ClassifiedReviewRow } from "@/db/queries/digest-window";

import {
  computeDigestWindow,
  handleComposeDigest,
  handleComposeDigestEnqueuer,
  isMondayEightAmLocal,
  isoWeekKey,
  type ComposeDigestDeps,
  type ComposeDigestEnqueuerDeps,
} from "../compose-digest";
import type { ComposeDigestPayload } from "../../boss";

const BUSINESS_ID = "biz-00000000-0000-0000-0000-000000000001";

function makeJob(payload: ComposeDigestPayload, id = "job-1"): Job<ComposeDigestPayload> {
  return {
    id,
    name: "compose_digest",
    data: payload,
  } as unknown as Job<ComposeDigestPayload>;
}

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: BUSINESS_ID,
    clerkOrgId: "org_test",
    name: "Acme Cafe",
    industry: "cafe",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    cancelledAt: null,
    ...overrides,
  } as Business;
}

function makeClassifiedRow(
  id: string,
  themes: string[],
  postedAt: Date,
  starRating = 4,
  sentiment: "positive" | "neutral" | "negative" = "neutral",
): ClassifiedReviewRow {
  return {
    review: {
      id,
      sourceConnectionId: "sc-1",
      source: "google",
      sourceReviewId: `g-${id}`,
      starRating,
      reviewText: "Some text.",
      reviewerDisplayName: "JaneD",
      redactedText: `Redacted text for ${id}.`,
      postedAt,
      ingestedAt: postedAt,
    } as ClassifiedReviewRow["review"],
    classification: {
      reviewId: id,
      promptVersion: "v1",
      isIncident: false,
      severity: null,
      themes,
      sentiment,
      suggestedReply: "Thanks for the feedback.",
      classifiedAt: postedAt,
    } as ClassifiedReviewRow["classification"],
  };
}

interface MakeDepsOptions {
  business?: Business | null;
  timezone?: string;
  currentReviews?: ClassifiedReviewRow[];
  previousReviews?: ClassifiedReviewRow[];
  operatorEmails?: string[];
  composedBody?: DigestBody;
  now?: Date;
}

function makeDeps(opts: MakeDepsOptions = {}): {
  deps: ComposeDigestDeps;
  spies: {
    composeDigest: ReturnType<typeof vi.fn>;
    insertDigest: ReturnType<typeof vi.fn>;
    sendEmail: ReturnType<typeof vi.fn>;
    findActiveOperatorEmailsForBusiness: ReturnType<typeof vi.fn>;
    findClassifiedReviewsForBusinessInPeriod: ReturnType<typeof vi.fn>;
  };
} {
  const business = opts.business === undefined ? makeBusiness() : opts.business;
  const now = opts.now ?? new Date("2026-05-25T13:00:00Z");

  const findClassifiedReviewsForBusinessInPeriod = vi.fn(
    async ({ periodStart }: { periodStart: Date }) => {
      // First call (current period) → current reviews, second call (previous) → previous.
      if (findClassifiedReviewsForBusinessInPeriod.mock.calls.length === 1) {
        return opts.currentReviews ?? [];
      }
      void periodStart;
      return opts.previousReviews ?? [];
    },
  );

  const composeDigest = vi.fn(async () => opts.composedBody ?? defaultBody());
  const insertDigest = vi.fn(async () => ({
    id: "dg-1",
    businessId: BUSINESS_ID,
    periodStart: new Date(),
    periodEnd: new Date(),
    body: opts.composedBody ?? defaultBody(),
    sentAt: new Date(),
  }));
  const sendEmail = vi.fn(async () => undefined);
  const findActiveOperatorEmailsForBusiness = vi.fn(async () => opts.operatorEmails ?? []);

  const deps: ComposeDigestDeps = {
    findActiveBusinessById: vi.fn(async () => business),
    findBusinessReferenceTimezone: vi.fn(async () => opts.timezone ?? "UTC"),
    findClassifiedReviewsForBusinessInPeriod,
    findActiveOperatorEmailsForBusiness,
    insertDigest,
    composeDigest,
    sendEmail,
    now: () => now,
  };

  return {
    deps,
    spies: {
      composeDigest,
      insertDigest,
      sendEmail,
      findActiveOperatorEmailsForBusiness,
      findClassifiedReviewsForBusinessInPeriod,
    },
  };
}

function defaultBody(): DigestBody {
  return {
    themeMovement: [{ theme: "service", delta: 1, direction: "up" }],
    topPatterns: [
      {
        patternId: "service-recovery-outreach",
        title: "Run a service-recovery outreach to the week's unhappy Reviewers",
        tailoredBody: "Tailored body.",
        evidence: [{ reviewId: "r1", starRating: 1, redactedQuote: "bad", themes: ["service"] }],
      },
      {
        patternId: "service-script-refresh",
        title: "Refresh front-line scripts for the top recurring complaint",
        tailoredBody: "Tailored body.",
        evidence: [{ reviewId: "r1", starRating: 1, redactedQuote: "bad", themes: ["service"] }],
      },
      {
        patternId: "service-shadow-shift",
        title: "Shadow a full shift to confirm the gap is real",
        tailoredBody: "Tailored body.",
        evidence: [{ reviewId: "r1", starRating: 1, redactedQuote: "bad", themes: ["service"] }],
      },
    ],
    overallTone: "concerning",
  };
}

describe("handleComposeDigest", () => {
  it("skips if < 1 Review in the current window — no Digest row, no email", async () => {
    const { deps, spies } = makeDeps({ currentReviews: [] });
    await handleComposeDigest([makeJob({ business_id: BUSINESS_ID })], deps);

    expect(spies.composeDigest).not.toHaveBeenCalled();
    expect(spies.insertDigest).not.toHaveBeenCalled();
    expect(spies.sendEmail).not.toHaveBeenCalled();
  });

  it("skips if the Business is missing / cancelled", async () => {
    const { deps, spies } = makeDeps({ business: null });
    await handleComposeDigest([makeJob({ business_id: BUSINESS_ID })], deps);

    expect(spies.composeDigest).not.toHaveBeenCalled();
    expect(spies.insertDigest).not.toHaveBeenCalled();
    expect(spies.sendEmail).not.toHaveBeenCalled();
  });

  it("persists the Digest row BEFORE sending email, sends one email per Operator with correct subject", async () => {
    const now = new Date("2026-05-25T13:00:00Z"); // Monday after the just-finished week
    const currentReviews = [
      makeClassifiedRow("r1", ["service"], new Date("2026-05-20T10:00:00Z"), 5, "positive"),
      makeClassifiedRow("r2", ["wait_time"], new Date("2026-05-21T10:00:00Z"), 4, "neutral"),
    ];

    const order: string[] = [];
    const { deps, spies } = makeDeps({
      now,
      currentReviews,
      previousReviews: [],
      operatorEmails: ["a@example.com", "b@example.com"],
    });
    // Wrap to record ordering.
    const origInsert = deps.insertDigest;
    deps.insertDigest = vi.fn(async (input: Parameters<typeof origInsert>[0]) => {
      order.push("insert");
      return origInsert(input);
    });
    const origSend = deps.sendEmail;
    deps.sendEmail = vi.fn(
      async (input: Parameters<typeof origSend>[0], options?: Parameters<typeof origSend>[1]) => {
        order.push("send");
        return origSend(input, options);
      },
    );

    await handleComposeDigest([makeJob({ business_id: BUSINESS_ID })], deps);

    expect(spies.composeDigest).toHaveBeenCalledTimes(1);
    expect(deps.insertDigest).toHaveBeenCalledTimes(1);
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    // Insert happens before any send.
    expect(order[0]).toBe("insert");
    expect(order.slice(1)).toEqual(["send", "send"]);

    // Subject + recipients.
    const sendCalls = (deps.sendEmail as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls[0][0].subject).toBe("Acme Cafe's week in review");
    expect(sendCalls[0][0].to).toEqual(["a@example.com"]);
    expect(sendCalls[1][0].to).toEqual(["b@example.com"]);
    // HTML body links to /app/dashboard with the slice-12-coordinated URL filter.
    expect(sendCalls[0][0].html).toContain("/app/dashboard?since=");
    expect(sendCalls[0][0].html).toContain("&amp;until=");
  });

  it("writes a Digest row even when the Business has zero Operator emails (audit trail)", async () => {
    const currentReviews = [makeClassifiedRow("r1", ["service"], new Date("2026-05-20T10:00:00Z"))];
    const { deps, spies } = makeDeps({
      currentReviews,
      operatorEmails: [],
    });
    await handleComposeDigest([makeJob({ business_id: BUSINESS_ID })], deps);

    expect(spies.insertDigest).toHaveBeenCalledTimes(1);
    expect(spies.sendEmail).not.toHaveBeenCalled();
  });
});

describe("isMondayEightAmLocal", () => {
  it("returns true at Monday 08:00 in the given timezone", () => {
    // 2026-05-25 is a Monday. 08:00 in America/New_York is 12:00 UTC.
    const now = new Date("2026-05-25T12:00:00Z");
    expect(isMondayEightAmLocal(now, "America/New_York")).toBe(true);
  });

  it("returns false at other hours of Monday", () => {
    const now = new Date("2026-05-25T13:00:00Z"); // 09:00 local
    expect(isMondayEightAmLocal(now, "America/New_York")).toBe(false);
  });

  it("returns false on non-Monday days", () => {
    // 2026-05-26 is a Tuesday.
    const now = new Date("2026-05-26T12:00:00Z");
    expect(isMondayEightAmLocal(now, "America/New_York")).toBe(false);
  });
});

describe("isoWeekKey", () => {
  it("returns ISO year-week in the given timezone", () => {
    // 2026-05-25 is a Monday, ISO week 22.
    const key = isoWeekKey(new Date("2026-05-25T12:00:00Z"), "America/New_York");
    expect(key).toBe("2026-W22");
  });
});

describe("handleComposeDigestEnqueuer", () => {
  it("enqueues compose_digest jobs for Businesses whose local clock is Monday 08:00", async () => {
    // Monday 08:00 in America/New_York (2026-05-25 08:00 ET = 12:00 UTC).
    const now = new Date("2026-05-25T12:00:00Z");

    const businesses: Business[] = [
      makeBusiness({ id: "biz-ny" }),
      makeBusiness({ id: "biz-utc" }),
    ];
    const timezones: Record<string, string> = {
      "biz-ny": "America/New_York",
      "biz-utc": "UTC",
    };

    const enqueueComposeDigest = vi.fn(async () => "job-id");
    const deps: ComposeDigestEnqueuerDeps = {
      listActiveBusinesses: vi.fn(async () => businesses),
      findBusinessReferenceTimezone: vi.fn(async (id: string) => timezones[id] ?? "UTC"),
      enqueueComposeDigest,
      now: () => now,
    };

    await handleComposeDigestEnqueuer(
      [{ id: "tick", name: "compose_digest_enqueuer", data: null } as unknown as Job<null>],
      deps,
    );

    // Only biz-ny matches (NY local clock is Monday 08:00); biz-utc is at 12:00 local on Monday.
    expect(enqueueComposeDigest).toHaveBeenCalledTimes(1);
    expect(enqueueComposeDigest).toHaveBeenCalledWith(
      { business_id: "biz-ny" },
      { isoYearWeek: "2026-W22" },
    );
  });

  it("skips Businesses whose local clock is NOT Monday 08:00", async () => {
    // Sunday at noon UTC — no Business should match.
    const now = new Date("2026-05-24T12:00:00Z");
    const enqueueComposeDigest = vi.fn(async () => "job-id");
    const deps: ComposeDigestEnqueuerDeps = {
      listActiveBusinesses: vi.fn(async () => [makeBusiness()]),
      findBusinessReferenceTimezone: vi.fn(async () => "America/New_York"),
      enqueueComposeDigest,
      now: () => now,
    };

    await handleComposeDigestEnqueuer(
      [{ id: "tick", name: "compose_digest_enqueuer", data: null } as unknown as Job<null>],
      deps,
    );
    expect(enqueueComposeDigest).not.toHaveBeenCalled();
  });

  it("continues even if one Business's enqueue throws", async () => {
    const now = new Date("2026-05-25T12:00:00Z"); // Monday 08:00 NY
    const businesses: Business[] = [makeBusiness({ id: "biz-a" }), makeBusiness({ id: "biz-b" })];
    const enqueueComposeDigest = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => "ok");
    const deps: ComposeDigestEnqueuerDeps = {
      listActiveBusinesses: vi.fn(async () => businesses),
      findBusinessReferenceTimezone: vi.fn(async () => "America/New_York"),
      enqueueComposeDigest,
      now: () => now,
    };

    await handleComposeDigestEnqueuer(
      [{ id: "tick", name: "compose_digest_enqueuer", data: null } as unknown as Job<null>],
      deps,
    );
    expect(enqueueComposeDigest).toHaveBeenCalledTimes(2);
  });
});

describe("computeDigestWindow", () => {
  it("returns Monday-to-Monday windows in the Business's timezone (UTC case)", () => {
    // Monday 2026-05-25 at 08:00 UTC.
    const now = new Date("2026-05-25T08:00:00Z");
    const { periodStart, periodEnd, previousStart } = computeDigestWindow(now, "UTC");
    expect(periodEnd.toISOString()).toBe("2026-05-25T00:00:00.000Z");
    expect(periodStart.toISOString()).toBe("2026-05-18T00:00:00.000Z");
    expect(previousStart.toISOString()).toBe("2026-05-11T00:00:00.000Z");
  });

  it("returns the same Monday boundaries even when the job dispatches mid-Monday", () => {
    const now = new Date("2026-05-25T20:00:00Z");
    const { periodStart, periodEnd } = computeDigestWindow(now, "UTC");
    expect(periodEnd.toISOString()).toBe("2026-05-25T00:00:00.000Z");
    expect(periodStart.toISOString()).toBe("2026-05-18T00:00:00.000Z");
  });
});
