/**
 * Unit tests for the `deliver_escalation` job handler (slice 11).
 *
 * Coverage required by issue #12:
 *   - Email path: Resend client receives subject, recipient list, draft-Reply
 *     framing, real Review text, real Reviewer name, dashboard link.
 *   - SMS path: Twilio client receives a body ≤ 320 chars, contains severity.
 *   - Status flips to `sent` on success, `failed` on final retry.
 *   - Transient failure pre-final-attempt re-throws so pg-boss retries.
 *   - Vanished Escalation → bail silently.
 *   - Already-sent Escalation → no double-send.
 *   - SMS without verified phone → throws meaningful error.
 */
import type { JobWithMetadata } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleDeliverEscalation, renderEmailHtml, renderSmsBody } from "../deliver-escalation";
import type { DeliverEscalationDeps } from "../deliver-escalation";
import type { DeliverEscalationPayload } from "../../boss";
import { DELIVER_ESCALATION_RETRY } from "../../boss";
import type { EscalationContext } from "@/db/queries/escalations";

const ESCALATION_ID = "esc-00000000-0000-0000-0000-000000000001";
const INCIDENT_ID = "inc-00000000-0000-0000-0000-000000000001";
const REVIEW_ID = "rev-00000000-0000-0000-0000-000000000001";
const OPERATOR_ID = "op-00000000-0000-0000-0000-000000000001";
const BUSINESS_ID = "biz-00000000-0000-0000-0000-000000000001";

function makeJob(
  payload: DeliverEscalationPayload,
  meta: { retryCount?: number } = {},
): JobWithMetadata<DeliverEscalationPayload> {
  return {
    id: "deliver-1",
    name: "deliver_escalation",
    data: payload,
    retryCount: meta.retryCount ?? 0,
  } as unknown as JobWithMetadata<DeliverEscalationPayload>;
}

function makeContext(overrides: Partial<EscalationContext> = {}): EscalationContext {
  const escalation = {
    id: ESCALATION_ID,
    incidentId: INCIDENT_ID,
    operatorId: OPERATOR_ID,
    channel: "email" as const,
    queuedAt: new Date(),
    deliveredAt: null,
    status: "queued" as const,
  };
  return {
    escalation,
    operator: {
      id: OPERATOR_ID,
      clerkUserId: "user_xxx",
      businessId: BUSINESS_ID,
      email: "ops@acme.example",
      name: "Ops Owner",
      createdAt: new Date(),
      deletedAt: null,
    },
    operatorPref: {
      operatorId: OPERATOR_ID,
      channel: "email",
      enabled: true,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: "UTC",
      phoneE164: null,
    },
    incident: {
      id: INCIDENT_ID,
      reviewId: REVIEW_ID,
      businessId: BUSINESS_ID,
      severity: "high",
      firedAt: new Date(),
      resolvedAt: null,
    },
    review: {
      id: REVIEW_ID,
      sourceConnectionId: "sc-1",
      source: "google",
      sourceReviewId: "google-1",
      starRating: 1,
      reviewText: "Worst experience of my life. Staff was rude.",
      reviewerDisplayName: "JaneD",
      redactedText: "Worst experience of my life. Staff was rude.",
      postedAt: new Date("2026-05-20T14:00:00Z"),
      ingestedAt: new Date(),
    },
    classification: {
      reviewId: REVIEW_ID,
      promptVersion: "v1",
      isIncident: true,
      severity: "high",
      themes: ["staff_attitude", "service"],
      sentiment: "negative",
      suggestedReply: "We are very sorry to hear about your experience, JaneD. Please reach out.",
      classifiedAt: new Date(),
    },
    business: {
      id: BUSINESS_ID,
      clerkOrgId: "org_xxx",
      name: "Acme Bakery",
      industry: "food_service",
      createdAt: new Date(),
      cancelledAt: null,
    },
    ...overrides,
  } as EscalationContext;
}

function makeDeps(
  opts: {
    context?: EscalationContext | null;
    sendEmailError?: Error;
    sendSmsError?: Error;
  } = {},
): {
  deps: DeliverEscalationDeps;
  spies: {
    findEscalationContext: ReturnType<typeof vi.fn>;
    markEscalationSent: ReturnType<typeof vi.fn>;
    markEscalationFailed: ReturnType<typeof vi.fn>;
    sendEmail: ReturnType<typeof vi.fn>;
    sendSms: ReturnType<typeof vi.fn>;
  };
} {
  const findEscalationContext = vi.fn(async (_id: string) =>
    opts.context === undefined ? makeContext() : opts.context,
  );
  const markEscalationSent = vi.fn(async (_id: string) => undefined);
  const markEscalationFailed = vi.fn(async (_id: string) => undefined);
  const sendEmail = vi.fn(async (_input: unknown) => {
    if (opts.sendEmailError) throw opts.sendEmailError;
  });
  const sendSms = vi.fn(async (_input: unknown) => {
    if (opts.sendSmsError) throw opts.sendSmsError;
  });

  const deps: DeliverEscalationDeps = {
    findEscalationContext,
    markEscalationSent,
    markEscalationFailed,
    sendEmail,
    sendSms,
  };
  return {
    deps,
    spies: {
      findEscalationContext,
      markEscalationSent,
      markEscalationFailed,
      sendEmail,
      sendSms,
    },
  };
}

describe("handleDeliverEscalation — Email", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("sends an Email containing the LLM-drafted reply, real Review text, and a dashboard link", async () => {
    const { deps, spies } = makeDeps();

    await handleDeliverEscalation([makeJob({ escalation_id: ESCALATION_ID })], deps);

    expect(spies.sendEmail).toHaveBeenCalledTimes(1);
    const arg = spies.sendEmail.mock.calls[0][0] as {
      to: string[];
      subject: string;
      html: string;
    };
    expect(arg.to).toEqual(["ops@acme.example"]);
    expect(arg.subject).toBe("[Acme Bakery] New Incident — high");
    // Real Reviewer name is shown to the Operator (ADR-0006 — redaction is
    // only for Anthropic).
    expect(arg.html).toContain("JaneD");
    // Real Review text.
    expect(arg.html).toContain("Worst experience of my life");
    // LLM draft.
    expect(arg.html).toContain("We are very sorry");
    // ADR-0003 framing.
    expect(arg.html).toContain("review and post via Google manually");
    // Dashboard link.
    expect(arg.html).toMatch(/\/app\/dashboard\?incident=/);
    // Themes appear.
    expect(arg.html).toContain("staff_attitude");

    expect(spies.markEscalationSent).toHaveBeenCalledWith(ESCALATION_ID);
  });
});

describe("handleDeliverEscalation — SMS", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("sends an SMS under 320 chars containing the severity and a dashboard link", async () => {
    const ctx = makeContext({
      escalation: {
        id: ESCALATION_ID,
        incidentId: INCIDENT_ID,
        operatorId: OPERATOR_ID,
        channel: "sms",
        queuedAt: new Date(),
        deliveredAt: null,
        status: "queued",
      },
      operatorPref: {
        operatorId: OPERATOR_ID,
        channel: "sms",
        enabled: true,
        quietHoursStart: null,
        quietHoursEnd: null,
        timezone: "UTC",
        phoneE164: "+15555550123",
      },
    });
    const { deps, spies } = makeDeps({ context: ctx });

    await handleDeliverEscalation([makeJob({ escalation_id: ESCALATION_ID })], deps);

    expect(spies.sendSms).toHaveBeenCalledTimes(1);
    const arg = spies.sendSms.mock.calls[0][0] as { to: string; body: string };
    expect(arg.to).toBe("+15555550123");
    expect(arg.body.length).toBeLessThanOrEqual(320);
    expect(arg.body).toContain("HIGH");
    expect(arg.body).toContain("Acme Bakery");
    expect(arg.body).toMatch(/\/app\/dashboard\?incident=/);

    expect(spies.markEscalationSent).toHaveBeenCalledWith(ESCALATION_ID);
  });

  it("throws a clear error when SMS is requested without a verified phone number", async () => {
    const ctx = makeContext({
      escalation: {
        id: ESCALATION_ID,
        incidentId: INCIDENT_ID,
        operatorId: OPERATOR_ID,
        channel: "sms",
        queuedAt: new Date(),
        deliveredAt: null,
        status: "queued",
      },
      operatorPref: {
        operatorId: OPERATOR_ID,
        channel: "sms",
        enabled: true,
        quietHoursStart: null,
        quietHoursEnd: null,
        timezone: "UTC",
        phoneE164: null,
      },
    });
    const { deps, spies } = makeDeps({ context: ctx });

    // Final attempt (retryCount == retryLimit) so the handler swallows the
    // throw and marks failed.
    await handleDeliverEscalation(
      [
        makeJob(
          { escalation_id: ESCALATION_ID },
          { retryCount: DELIVER_ESCALATION_RETRY.retryLimit },
        ),
      ],
      deps,
    );
    expect(spies.sendSms).not.toHaveBeenCalled();
    expect(spies.markEscalationFailed).toHaveBeenCalledWith(ESCALATION_ID);
  });

  it("renderSmsBody truncates long Review text to keep total ≤ 320 chars", () => {
    const longText = "A".repeat(800);
    const ctx = makeContext({
      review: {
        ...makeContext().review,
        reviewText: longText,
      },
    });
    const body = renderSmsBody(ctx);
    expect(body.length).toBeLessThanOrEqual(320);
    expect(body).toContain("HIGH");
  });
});

describe("handleDeliverEscalation — retry behaviour", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("re-throws on a transient failure pre-final-attempt so pg-boss retries", async () => {
    const { deps, spies } = makeDeps({ sendEmailError: new Error("Resend 503") });

    await expect(
      handleDeliverEscalation([makeJob({ escalation_id: ESCALATION_ID }, { retryCount: 0 })], deps),
    ).rejects.toThrow("Resend 503");
    expect(spies.markEscalationFailed).not.toHaveBeenCalled();
    expect(spies.markEscalationSent).not.toHaveBeenCalled();
  });

  it("marks the Escalation failed on the final attempt and does NOT re-throw", async () => {
    const { deps, spies } = makeDeps({ sendEmailError: new Error("Resend 503") });

    await handleDeliverEscalation(
      [
        makeJob(
          { escalation_id: ESCALATION_ID },
          { retryCount: DELIVER_ESCALATION_RETRY.retryLimit },
        ),
      ],
      deps,
    );

    expect(spies.markEscalationFailed).toHaveBeenCalledWith(ESCALATION_ID);
    expect(spies.markEscalationSent).not.toHaveBeenCalled();
  });
});

describe("handleDeliverEscalation — bail / idempotency", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("bails silently when the Escalation row has vanished", async () => {
    const { deps, spies } = makeDeps({ context: null });

    await handleDeliverEscalation([makeJob({ escalation_id: ESCALATION_ID })], deps);

    expect(spies.sendEmail).not.toHaveBeenCalled();
    expect(spies.sendSms).not.toHaveBeenCalled();
    expect(spies.markEscalationSent).not.toHaveBeenCalled();
  });

  it("does not double-send when the Escalation is already marked sent", async () => {
    const ctx = makeContext({
      escalation: {
        id: ESCALATION_ID,
        incidentId: INCIDENT_ID,
        operatorId: OPERATOR_ID,
        channel: "email",
        queuedAt: new Date(),
        deliveredAt: new Date(),
        status: "sent",
      },
    });
    const { deps, spies } = makeDeps({ context: ctx });

    await handleDeliverEscalation([makeJob({ escalation_id: ESCALATION_ID })], deps);

    expect(spies.sendEmail).not.toHaveBeenCalled();
    expect(spies.markEscalationSent).not.toHaveBeenCalled();
  });
});

describe("renderEmailHtml — direct unit", () => {
  it("HTML-escapes the Reviewer name and Review text", () => {
    const ctx = makeContext({
      review: {
        ...makeContext().review,
        reviewerDisplayName: "<script>alert(1)</script>",
        reviewText: "<b>bold attack</b>",
      },
    });
    const html = renderEmailHtml(ctx);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>bold attack</b>");
    expect(html).toContain("&lt;b&gt;");
  });
});
