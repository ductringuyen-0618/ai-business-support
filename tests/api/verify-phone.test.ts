/**
 * Route tests for the phone-verification round-trip (slice 11).
 *
 * Covers the acceptance criteria from issue #12:
 *   - `start` sends an SMS with a 6-digit code and persists a pending row.
 *   - `confirm` with the matching code enables SMS + records the number.
 *   - `confirm` with a mismatched code returns 400 and DOES NOT enable.
 *   - `confirm` for an expired code returns 400.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/db/queries/operators", () => ({
  getOperatorWithBusinessByClerkUserId: vi.fn(),
}));
vi.mock("@/db/queries/phone-verifications", () => ({
  upsertPendingVerification: vi.fn(),
  findPendingVerification: vi.fn(),
  deletePendingVerification: vi.fn(),
}));
vi.mock("@/db/queries/operator-channel-prefs", () => ({
  enableSmsWithVerifiedNumber: vi.fn(),
}));
vi.mock("@/lib/sms/twilio", () => ({
  sendSms: vi.fn(),
}));

const clerk = await import("@clerk/nextjs/server");
const operatorsQuery = await import("@/db/queries/operators");
const verifications = await import("@/db/queries/phone-verifications");
const prefs = await import("@/db/queries/operator-channel-prefs");
const sms = await import("@/lib/sms/twilio");

const startRoute = await import("@/app/api/operator/verify-phone/start/route");
const confirmRoute = await import("@/app/api/operator/verify-phone/confirm/route");

const OPERATOR_ID = "op-00000000-0000-0000-0000-000000000001";
const BUSINESS_ID = "biz-00000000-0000-0000-0000-000000000001";

function req(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(clerk.auth).mockResolvedValue({ userId: "user_xxx" } as never);
  vi.mocked(operatorsQuery.getOperatorWithBusinessByClerkUserId).mockResolvedValue({
    operator: { id: OPERATOR_ID, businessId: BUSINESS_ID } as never,
    business: { id: BUSINESS_ID, name: "Acme" } as never,
  });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/operator/verify-phone/start", () => {
  it("400 on non-E.164 phone number", async () => {
    const res = await startRoute.POST(
      req("/api/operator/verify-phone/start", { phoneE164: "5555550123" }),
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(sms.sendSms)).not.toHaveBeenCalled();
  });

  it("persists a pending verification + sends a 6-digit code via SMS", async () => {
    vi.mocked(verifications.upsertPendingVerification).mockResolvedValue(undefined);
    vi.mocked(sms.sendSms).mockResolvedValue(undefined);

    const res = await startRoute.POST(
      req("/api/operator/verify-phone/start", { phoneE164: "+15555550123" }),
    );
    expect(res.status).toBe(200);

    expect(vi.mocked(verifications.upsertPendingVerification)).toHaveBeenCalledTimes(1);
    const pendingArg = vi.mocked(verifications.upsertPendingVerification).mock.calls[0][0];
    expect(pendingArg.operatorId).toBe(OPERATOR_ID);
    expect(pendingArg.phoneE164).toBe("+15555550123");
    expect(pendingArg.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(pendingArg.expiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(vi.mocked(sms.sendSms)).toHaveBeenCalledTimes(1);
    const smsArg = vi.mocked(sms.sendSms).mock.calls[0][0];
    expect(smsArg.to).toBe("+15555550123");
    expect(smsArg.body).toMatch(/verification code is \d{6}\./);
  });
});

describe("POST /api/operator/verify-phone/confirm", () => {
  it("returns 200 + enables SMS when the submitted code hash matches", async () => {
    // Stage a pending verification with a known plaintext code → known hash.
    const { hashVerificationCode } = await import("@/lib/phone-verify");
    const code = "424242";
    vi.mocked(verifications.findPendingVerification).mockResolvedValue({
      operatorId: OPERATOR_ID,
      phoneE164: "+15555550123",
      codeHash: hashVerificationCode(code),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });

    const res = await confirmRoute.POST(req("/api/operator/verify-phone/confirm", { code }));
    expect(res.status).toBe(200);
    expect(vi.mocked(prefs.enableSmsWithVerifiedNumber)).toHaveBeenCalledWith({
      operatorId: OPERATOR_ID,
      phoneE164: "+15555550123",
    });
    expect(vi.mocked(verifications.deletePendingVerification)).toHaveBeenCalledWith(OPERATOR_ID);
  });

  it("returns 400 when the submitted code does NOT match and does NOT enable", async () => {
    const { hashVerificationCode } = await import("@/lib/phone-verify");
    vi.mocked(verifications.findPendingVerification).mockResolvedValue({
      operatorId: OPERATOR_ID,
      phoneE164: "+15555550123",
      codeHash: hashVerificationCode("111111"),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });

    const res = await confirmRoute.POST(
      req("/api/operator/verify-phone/confirm", { code: "999999" }),
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(prefs.enableSmsWithVerifiedNumber)).not.toHaveBeenCalled();
    // The row stays — a fat-fingered digit shouldn't burn the round-trip.
    expect(vi.mocked(verifications.deletePendingVerification)).not.toHaveBeenCalled();
  });

  it("returns 400 when the pending verification has expired", async () => {
    const { hashVerificationCode } = await import("@/lib/phone-verify");
    const code = "424242";
    vi.mocked(verifications.findPendingVerification).mockResolvedValue({
      operatorId: OPERATOR_ID,
      phoneE164: "+15555550123",
      codeHash: hashVerificationCode(code),
      expiresAt: new Date(Date.now() - 1_000),
      createdAt: new Date(),
    });

    const res = await confirmRoute.POST(req("/api/operator/verify-phone/confirm", { code }));
    expect(res.status).toBe(400);
    expect(vi.mocked(prefs.enableSmsWithVerifiedNumber)).not.toHaveBeenCalled();
    // Expired rows ARE cleaned up.
    expect(vi.mocked(verifications.deletePendingVerification)).toHaveBeenCalledWith(OPERATOR_ID);
  });

  it("returns 400 when there is no pending verification at all", async () => {
    vi.mocked(verifications.findPendingVerification).mockResolvedValue(null);
    const res = await confirmRoute.POST(
      req("/api/operator/verify-phone/confirm", { code: "424242" }),
    );
    expect(res.status).toBe(400);
  });
});
