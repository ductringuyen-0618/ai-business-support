/**
 * Unit tests for the `fire_incident` job handler.
 *
 * Strategy mirrors `ingest-review.test.ts`: dependency-inject the DB + router
 * + enqueue helper and assert on the spy call counts/payloads.
 *
 * Coverage required by issue #12:
 *   - Happy path: 1 Incident + N Escalations (per the EscalationRouter output).
 *   - Idempotency: re-running on the same review_id produces the same artefacts
 *     and DOES NOT re-fan-out (count check skips the second router run).
 *   - Vanished Review: bail silently.
 *   - Classification flipped to not-incident: bail silently.
 *   - Quiet-hours deferral: `enqueueDeliverEscalation` receives a `startAfter`
 *     ≈ end-of-quiet-hours from the real EscalationRouter.
 *   - No active Operators: Incident is created, no Escalations.
 *   - Default Email pref for an Operator with no rows: Email Escalation is
 *     still produced.
 */
import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClassificationRow, IncidentRow, EscalationRow } from "@/db/schema";
import type { OperatorWithPrefs } from "@/db/queries/operator-channel-prefs";
import type { ReviewWithBusinessId } from "@/db/queries/reviews";

import { handleFireIncident, type FireIncidentDeps } from "../fire-incident";
import type { FireIncidentPayload } from "../../boss";

const REVIEW_ID = "rev-00000000-0000-0000-0000-000000000001";
const BUSINESS_ID = "biz-00000000-0000-0000-0000-000000000001";
const INCIDENT_ID = "inc-00000000-0000-0000-0000-000000000001";
const OPERATOR_A = "op-00000000-0000-0000-0000-00000000000a";
const OPERATOR_B = "op-00000000-0000-0000-0000-00000000000b";

function makeJob(payload: FireIncidentPayload): Job<FireIncidentPayload> {
  return {
    id: "job-fire-1",
    name: "fire_incident",
    data: payload,
  } as unknown as Job<FireIncidentPayload>;
}

function makeReview(): ReviewWithBusinessId {
  return {
    id: REVIEW_ID,
    sourceConnectionId: "sc-1",
    source: "google",
    sourceReviewId: "google-rev-1",
    starRating: 1,
    reviewText: "Terrible service.",
    reviewerDisplayName: "JaneD",
    redactedText: "Terrible service from [REVIEWER].",
    postedAt: new Date("2026-05-20T14:00:00Z"),
    ingestedAt: new Date("2026-05-20T14:01:00Z"),
    businessId: BUSINESS_ID,
  } as ReviewWithBusinessId;
}

function makeClassification(overrides: Partial<ClassificationRow> = {}): ClassificationRow {
  return {
    reviewId: REVIEW_ID,
    promptVersion: "v1",
    isIncident: true,
    severity: "high",
    themes: ["staff_attitude"],
    sentiment: "negative",
    suggestedReply: "We're sorry.",
    classifiedAt: new Date("2026-05-20T14:02:00Z"),
    ...overrides,
  } as ClassificationRow;
}

function makeIncident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: INCIDENT_ID,
    reviewId: REVIEW_ID,
    businessId: BUSINESS_ID,
    severity: "high",
    firedAt: new Date("2026-05-20T14:03:00Z"),
    resolvedAt: null,
    ...overrides,
  } as IncidentRow;
}

interface MakeDepsOptions {
  reviewMissing?: boolean;
  classification?: ClassificationRow | null;
  existingEscalationCount?: number;
  operators?: OperatorWithPrefs[];
  now?: Date;
}

async function makeDeps(opts: MakeDepsOptions = {}): Promise<{
  deps: FireIncidentDeps;
  spies: {
    findReviewWithBusinessId: ReturnType<typeof vi.fn>;
    findClassificationByReviewId: ReturnType<typeof vi.fn>;
    upsertIncidentByReviewId: ReturnType<typeof vi.fn>;
    countEscalationsForIncident: ReturnType<typeof vi.fn>;
    findOperatorsWithPrefsByBusiness: ReturnType<typeof vi.fn>;
    insertEscalation: ReturnType<typeof vi.fn>;
    enqueueDeliverEscalation: ReturnType<typeof vi.fn>;
    route: ReturnType<typeof vi.fn>;
  };
}> {
  const findReviewWithBusinessId = vi.fn(async (_id: string) =>
    opts.reviewMissing ? null : makeReview(),
  );
  const findClassificationByReviewId = vi.fn(async (_reviewId: string) =>
    opts.classification === undefined ? makeClassification() : opts.classification,
  );
  const upsertIncidentByReviewId = vi.fn(async (_input: unknown) => makeIncident());
  const countEscalationsForIncident = vi.fn(
    async (_id: string) => opts.existingEscalationCount ?? 0,
  );
  const findOperatorsWithPrefsByBusiness = vi.fn(
    async (_id: string) =>
      opts.operators ?? [
        // Default: two Operators, both Email-only, no quiet hours.
        {
          operatorId: OPERATOR_A,
          prefs: [
            {
              operatorId: OPERATOR_A,
              channel: "email" as const,
              enabled: true,
              quietHoursStart: null,
              quietHoursEnd: null,
              timezone: "UTC",
              phoneE164: null,
            },
          ],
        },
        {
          operatorId: OPERATOR_B,
          prefs: [
            {
              operatorId: OPERATOR_B,
              channel: "email" as const,
              enabled: true,
              quietHoursStart: null,
              quietHoursEnd: null,
              timezone: "UTC",
              phoneE164: null,
            },
          ],
        },
      ],
  );
  let escalationCounter = 0;
  const insertEscalation = vi.fn(async (input: unknown) => {
    const cast = input as { incidentId: string; operatorId: string; channel: "email" | "sms" };
    escalationCounter += 1;
    return {
      id: `esc-${escalationCounter}`,
      incidentId: cast.incidentId,
      operatorId: cast.operatorId,
      channel: cast.channel,
      queuedAt: new Date(),
      deliveredAt: null,
      status: "queued",
    } as EscalationRow;
  });
  const enqueueDeliverEscalation = vi.fn(async (_payload: unknown, _opts?: unknown) => "queued-1");

  // Use the REAL router by default — the test that asserts on quiet-hours
  // deferral relies on real router math.
  const { route: realRoute } = await importRouter();
  const route = vi.fn(realRoute);

  const deps: FireIncidentDeps = {
    findReviewWithBusinessId,
    findClassificationByReviewId,
    upsertIncidentByReviewId,
    countEscalationsForIncident,
    findOperatorsWithPrefsByBusiness,
    insertEscalation,
    enqueueDeliverEscalation,
    route,
    now: () => opts.now ?? new Date("2026-05-23T12:00:00Z"),
  };

  return {
    deps,
    spies: {
      findReviewWithBusinessId,
      findClassificationByReviewId,
      upsertIncidentByReviewId,
      countEscalationsForIncident,
      findOperatorsWithPrefsByBusiness,
      insertEscalation,
      enqueueDeliverEscalation,
      route,
    },
  };
}

async function importRouter() {
  return import("@/lib/escalation");
}

describe("handleFireIncident — happy path", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("creates 1 incident row + N escalations (one per enabled Operator×Channel pair)", async () => {
    const { deps, spies } = await makeDeps();

    await handleFireIncident([makeJob({ review_id: REVIEW_ID })], deps);

    expect(spies.upsertIncidentByReviewId).toHaveBeenCalledTimes(1);
    expect(spies.upsertIncidentByReviewId).toHaveBeenCalledWith({
      reviewId: REVIEW_ID,
      businessId: BUSINESS_ID,
      severity: "high",
    });

    // Two Operators, Email each → 2 Escalations.
    expect(spies.insertEscalation).toHaveBeenCalledTimes(2);
    expect(spies.enqueueDeliverEscalation).toHaveBeenCalledTimes(2);

    // Channel is Email on both.
    const channels = spies.insertEscalation.mock.calls.map(
      (c) => (c[0] as { channel: string }).channel,
    );
    expect(channels.sort()).toEqual(["email", "email"]);
  });
});

describe("handleFireIncident — idempotency", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("does NOT re-fan-out when the Incident already has Escalations", async () => {
    const { deps, spies } = await makeDeps({ existingEscalationCount: 2 });

    await handleFireIncident([makeJob({ review_id: REVIEW_ID })], deps);

    // The Incident still upserts (no-op-ish), but no new Escalations.
    expect(spies.upsertIncidentByReviewId).toHaveBeenCalledTimes(1);
    expect(spies.insertEscalation).not.toHaveBeenCalled();
    expect(spies.enqueueDeliverEscalation).not.toHaveBeenCalled();
    // The router is never invoked when we're skipping fan-out — there's
    // nothing to derive.
    expect(spies.route).not.toHaveBeenCalled();
  });
});

describe("handleFireIncident — bail cases", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("bails silently when the Review has vanished", async () => {
    const { deps, spies } = await makeDeps({ reviewMissing: true });

    await handleFireIncident([makeJob({ review_id: REVIEW_ID })], deps);

    expect(spies.upsertIncidentByReviewId).not.toHaveBeenCalled();
    expect(spies.insertEscalation).not.toHaveBeenCalled();
  });

  it("bails silently when the Classification is missing", async () => {
    const { deps, spies } = await makeDeps({ classification: null });

    await handleFireIncident([makeJob({ review_id: REVIEW_ID })], deps);

    expect(spies.upsertIncidentByReviewId).not.toHaveBeenCalled();
  });

  it("bails silently when the Classification has been flipped to not-incident", async () => {
    const { deps, spies } = await makeDeps({
      classification: makeClassification({ isIncident: false, severity: null }),
    });

    await handleFireIncident([makeJob({ review_id: REVIEW_ID })], deps);

    expect(spies.upsertIncidentByReviewId).not.toHaveBeenCalled();
  });

  it("creates the Incident but emits no Escalations when there are no active Operators", async () => {
    const { deps, spies } = await makeDeps({ operators: [] });

    await handleFireIncident([makeJob({ review_id: REVIEW_ID })], deps);

    expect(spies.upsertIncidentByReviewId).toHaveBeenCalledTimes(1);
    expect(spies.insertEscalation).not.toHaveBeenCalled();
  });
});

describe("handleFireIncident — quiet hours deferral", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("passes `startAfter` ≈ end-of-quiet-hours when the Operator is mid-quiet-hours", async () => {
    // 02:30 UTC, Operator A has quiet hours 02:00-06:00 UTC on Email.
    const now = new Date("2026-05-23T02:30:00.000Z");
    const { deps, spies } = await makeDeps({
      now,
      operators: [
        {
          operatorId: OPERATOR_A,
          prefs: [
            {
              operatorId: OPERATOR_A,
              channel: "email" as const,
              enabled: true,
              quietHoursStart: "02:00",
              quietHoursEnd: "06:00",
              timezone: "UTC",
              phoneE164: null,
            },
          ],
        },
      ],
    });

    await handleFireIncident([makeJob({ review_id: REVIEW_ID })], deps);

    expect(spies.enqueueDeliverEscalation).toHaveBeenCalledTimes(1);
    const [, options] = spies.enqueueDeliverEscalation.mock.calls[0];
    const startAfter = (options as { startAfter: Date }).startAfter;
    expect(startAfter.toISOString()).toBe("2026-05-23T06:00:00.000Z");
  });
});

describe("handleFireIncident — default Email pref synthesis", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("emits an Email Escalation for an Operator with no pref rows yet", async () => {
    const { deps, spies } = await makeDeps({
      operators: [{ operatorId: OPERATOR_A, prefs: [] }],
    });

    await handleFireIncident([makeJob({ review_id: REVIEW_ID })], deps);

    expect(spies.insertEscalation).toHaveBeenCalledTimes(1);
    expect(spies.insertEscalation).toHaveBeenCalledWith({
      incidentId: INCIDENT_ID,
      operatorId: OPERATOR_A,
      channel: "email",
    });
  });
});
