/**
 * Tests for the `POST /api/webhooks/clerk` route handler.
 *
 * We exercise the real Svix signature verification path with a real Svix
 * Webhook to sign payloads — that way we know we're testing the exact code
 * Clerk's deliveries will hit, not a stub. The DB write path is replaced via a
 * vi.mock of `@/db/client` because the route is just glue here; the row-level
 * contract is covered by `clerk-events.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";

const TEST_SECRET = "whsec_" + Buffer.from("test-test-test-test-test-test").toString("base64");

// Captures the events `applyClerkEvent` was called with so tests can assert
// dispatch happened (or didn't).
const applied: unknown[] = [];

vi.mock("@/db/client", () => ({
  getDb: () => ({ __fake: true }),
}));

vi.mock("@/webhooks/clerk-events", async () => {
  const actual =
    await vi.importActual<typeof import("@/webhooks/clerk-events")>("@/webhooks/clerk-events");
  return {
    ...actual,
    applyClerkEvent: vi.fn(async (_db: unknown, event: unknown) => {
      applied.push(event);
      return { kind: "business.upserted", clerkOrgId: "org_abc" };
    }),
  };
});

// Next 15's `headers()` is an async function returning a ReadonlyHeaders.
// We swap it for a synchronous-then-returned function bound to a per-test
// Headers object so the route handler reads what the test sets.
let currentHeaders = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => currentHeaders,
}));

const { POST } = await import("@/app/api/webhooks/clerk/route");

beforeEach(() => {
  applied.length = 0;
  currentHeaders = new Headers();
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = TEST_SECRET;
});

afterEach(() => {
  vi.clearAllMocks();
});

function sign(payload: object): { body: string; headers: Headers } {
  const body = JSON.stringify(payload);
  const wh = new Webhook(TEST_SECRET);
  const msgId = "msg_" + Math.random().toString(36).slice(2);
  // svix-js exposes `sign(msgId, timestamp, payload)` — used to produce the
  // exact signature header Clerk would send.
  const timestamp = new Date();
  const signature = wh.sign(msgId, timestamp, body);
  const headers = new Headers();
  headers.set("svix-id", msgId);
  headers.set("svix-timestamp", Math.floor(timestamp.getTime() / 1000).toString());
  headers.set("svix-signature", signature);
  return { body, headers };
}

function makeRequest(body: string): Request {
  return new Request("http://localhost/api/webhooks/clerk", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/webhooks/clerk", () => {
  it("returns 401 when no signature headers are present", async () => {
    const res = await POST(makeRequest(JSON.stringify({ type: "organization.created" })));
    expect(res.status).toBe(401);
    expect(applied).toHaveLength(0);
  });

  it("returns 401 when the signature is wrong", async () => {
    const { body, headers } = sign({
      type: "organization.created",
      data: { id: "org_abc", name: "Test" },
    });
    // Tamper with the body after signing.
    const tamperedBody = body.replace("Test", "Tampered");
    currentHeaders = headers;
    const res = await POST(makeRequest(tamperedBody));
    expect(res.status).toBe(401);
    expect(applied).toHaveLength(0);
  });

  it("returns 200 and dispatches the event when signature is valid", async () => {
    const payload = {
      type: "organization.created",
      data: { id: "org_abc", name: "Test Diner" },
    };
    const { body, headers } = sign(payload);
    currentHeaders = headers;
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject(payload);
  });

  it("returns 200 (idempotent) when the same signed event is replayed", async () => {
    const payload = {
      type: "organization.created",
      data: { id: "org_abc", name: "Test Diner" },
    };
    const { body, headers } = sign(payload);
    currentHeaders = headers;
    const first = await POST(makeRequest(body));
    expect(first.status).toBe(200);
    // Svix replay-protection happens in production via msg-id storage; at the
    // HTTP layer we just need to confirm a re-delivery doesn't error.
    currentHeaders = headers;
    const second = await POST(makeRequest(body));
    expect(second.status).toBe(200);
    expect(applied).toHaveLength(2);
  });

  it("returns 400 when the payload is malformed (handler throws WebhookPayloadError)", async () => {
    // Force the mocked handler to throw a WebhookPayloadError to exercise the
    // 400 branch of the route.
    const events = await import("@/webhooks/clerk-events");
    (events.applyClerkEvent as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new events.WebhookPayloadError("organization.created missing id or name");
      },
    );

    const { body, headers } = sign({ type: "organization.created", data: {} });
    currentHeaders = headers;
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(400);
  });

  it("returns 500 when the secret is missing from env", async () => {
    delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    const res = await POST(makeRequest(JSON.stringify({})));
    expect(res.status).toBe(500);
  });
});
