/**
 * Route tests for `POST /api/operator/channel-prefs` (slice 11).
 *
 * Strategy: vi.mock the auth + DB boundary; assert on the spy call payloads
 * + HTTP status. Mirrors `tests/webhooks/clerk-route.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));
vi.mock("@/db/queries/operators", () => ({
  getOperatorWithBusinessByClerkUserId: vi.fn(),
}));
vi.mock("@/db/queries/operator-channel-prefs", () => ({
  upsertChannelPref: vi.fn(),
}));

const clerk = await import("@clerk/nextjs/server");
const operatorsQuery = await import("@/db/queries/operators");
const prefsQuery = await import("@/db/queries/operator-channel-prefs");
const { POST } = await import("@/app/api/operator/channel-prefs/route");

const OPERATOR_ID = "op-00000000-0000-0000-0000-000000000001";
const BUSINESS_ID = "biz-00000000-0000-0000-0000-000000000001";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/operator/channel-prefs", {
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
  vi.mocked(prefsQuery.upsertChannelPref).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/operator/channel-prefs", () => {
  it("returns 401 when Clerk has no userId", async () => {
    vi.mocked(clerk.auth).mockResolvedValueOnce({ userId: null } as never);
    const res = await POST(
      makeRequest({
        email: { enabled: true, quietHoursStart: null, quietHoursEnd: null, timezone: "UTC" },
        sms: { enabled: false, quietHoursStart: null, quietHoursEnd: null, timezone: "UTC" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when no Operator row exists for the Clerk user", async () => {
    vi.mocked(operatorsQuery.getOperatorWithBusinessByClerkUserId).mockResolvedValueOnce(null);
    const res = await POST(
      makeRequest({
        email: { enabled: true, quietHoursStart: null, quietHoursEnd: null, timezone: "UTC" },
        sms: { enabled: false, quietHoursStart: null, quietHoursEnd: null, timezone: "UTC" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for a malformed body", async () => {
    const res = await POST(
      makeRequest({
        email: { enabled: "yes" }, // wrong type, missing fields
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown IANA timezone", async () => {
    const res = await POST(
      makeRequest({
        email: {
          enabled: true,
          quietHoursStart: null,
          quietHoursEnd: null,
          timezone: "Mars/Olympus_Mons",
        },
        sms: { enabled: false, quietHoursStart: null, quietHoursEnd: null, timezone: "UTC" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("upserts both rows on a valid payload and returns 200", async () => {
    const res = await POST(
      makeRequest({
        email: {
          enabled: true,
          quietHoursStart: "22:00",
          quietHoursEnd: "07:00",
          timezone: "America/Los_Angeles",
        },
        sms: { enabled: false, quietHoursStart: null, quietHoursEnd: null, timezone: "UTC" },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(prefsQuery.upsertChannelPref)).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(prefsQuery.upsertChannelPref).mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual({
      operatorId: OPERATOR_ID,
      channel: "email",
      enabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      timezone: "America/Los_Angeles",
    });
    expect(calls).toContainEqual({
      operatorId: OPERATOR_ID,
      channel: "sms",
      enabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: "UTC",
    });
  });
});
