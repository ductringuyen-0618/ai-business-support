/**
 * Unit tests for the Clerk webhook event handlers.
 *
 * The handlers are exercised against an in-memory `fake-db` that mimics just
 * enough of Drizzle to let us assert on row state after each event. We mock
 * `drizzle-orm`'s `eq` + `sql` exports so the handler's predicates and
 * timestamp expressions land as plain JS values our fake understands.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeEq, fakeSql, makeFakeDb } from "./fake-db";

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: fakeEq,
    sql: fakeSql,
  };
});

// Imported AFTER vi.mock so the handler module sees the mocked drizzle-orm.
const { applyClerkEvent, WebhookPayloadError } = await import("@/webhooks/clerk-events");

describe("applyClerkEvent", () => {
  let harness: ReturnType<typeof makeFakeDb>;

  beforeEach(() => {
    harness = makeFakeDb();
  });

  describe("organization.created", () => {
    it("inserts a businesses row keyed on clerk_org_id", async () => {
      const outcome = await applyClerkEvent(harness.db, {
        type: "organization.created",
        data: {
          id: "org_abc",
          name: "Test Diner",
          public_metadata: { industry: "restaurant" },
        },
      });

      expect(outcome).toEqual({ kind: "business.upserted", clerkOrgId: "org_abc" });
      expect(harness.state.businesses).toHaveLength(1);
      expect(harness.state.businesses[0]).toMatchObject({
        clerkOrgId: "org_abc",
        name: "Test Diner",
        industry: "restaurant",
        cancelledAt: null,
      });
    });

    it("is idempotent on replay (Clerk retries)", async () => {
      const event = {
        type: "organization.created" as const,
        data: { id: "org_abc", name: "Test Diner" },
      };
      await applyClerkEvent(harness.db, event);
      await applyClerkEvent(harness.db, event);

      expect(harness.state.businesses).toHaveLength(1);
    });

    it("updates the existing business when the name changes (organization.updated)", async () => {
      await applyClerkEvent(harness.db, {
        type: "organization.created",
        data: { id: "org_abc", name: "Old Name" },
      });
      await applyClerkEvent(harness.db, {
        type: "organization.updated",
        data: { id: "org_abc", name: "New Name" },
      });

      expect(harness.state.businesses).toHaveLength(1);
      expect(harness.state.businesses[0].name).toBe("New Name");
    });

    it("rejects a malformed payload (missing name)", async () => {
      await expect(
        applyClerkEvent(harness.db, {
          type: "organization.created",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { id: "org_abc" } as any,
        }),
      ).rejects.toBeInstanceOf(WebhookPayloadError);
    });
  });

  describe("organizationMembership.created", () => {
    beforeEach(async () => {
      await applyClerkEvent(harness.db, {
        type: "organization.created",
        data: { id: "org_abc", name: "Test Diner" },
      });
    });

    it("inserts an operators row tied to the right business_id", async () => {
      const outcome = await applyClerkEvent(harness.db, {
        type: "organizationMembership.created",
        data: {
          organization: { id: "org_abc" },
          public_user_data: {
            user_id: "user_123",
            identifier: "operator@example.com",
            first_name: "Maria",
            last_name: "Lopez",
          },
        },
      });

      expect(outcome).toEqual({
        kind: "operator.upserted",
        clerkUserId: "user_123",
        clerkOrgId: "org_abc",
      });
      expect(harness.state.operators).toHaveLength(1);
      const operator = harness.state.operators[0];
      expect(operator.clerkUserId).toBe("user_123");
      expect(operator.email).toBe("operator@example.com");
      expect(operator.name).toBe("Maria Lopez");
      expect(operator.businessId).toBe(harness.state.businesses[0].id);
      expect(operator.deletedAt).toBeNull();
    });

    it("is idempotent on replay", async () => {
      const event = {
        type: "organizationMembership.created" as const,
        data: {
          organization: { id: "org_abc" },
          public_user_data: {
            user_id: "user_123",
            identifier: "operator@example.com",
            first_name: "Maria",
          },
        },
      };
      await applyClerkEvent(harness.db, event);
      await applyClerkEvent(harness.db, event);

      expect(harness.state.operators).toHaveLength(1);
    });

    it("re-activates a previously soft-deleted operator on rejoin", async () => {
      await applyClerkEvent(harness.db, {
        type: "organizationMembership.created",
        data: {
          organization: { id: "org_abc" },
          public_user_data: { user_id: "user_123", identifier: "m@example.com" },
        },
      });
      await applyClerkEvent(harness.db, {
        type: "user.deleted",
        data: { id: "user_123" },
      });
      expect(harness.state.operators[0].deletedAt).not.toBeNull();

      await applyClerkEvent(harness.db, {
        type: "organizationMembership.created",
        data: {
          organization: { id: "org_abc" },
          public_user_data: { user_id: "user_123", identifier: "m@example.com" },
        },
      });
      expect(harness.state.operators[0].deletedAt).toBeNull();
    });

    it("throws when the parent business has not been seeded yet", async () => {
      await expect(
        applyClerkEvent(harness.db, {
          type: "organizationMembership.created",
          data: {
            organization: { id: "org_does_not_exist" },
            public_user_data: { user_id: "user_123", identifier: "m@example.com" },
          },
        }),
      ).rejects.toBeInstanceOf(WebhookPayloadError);
    });

    it("rejects a malformed payload (missing identifier)", async () => {
      await expect(
        applyClerkEvent(harness.db, {
          type: "organizationMembership.created",
          data: {
            organization: { id: "org_abc" },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            public_user_data: { user_id: "user_123" } as any,
          },
        }),
      ).rejects.toBeInstanceOf(WebhookPayloadError);
    });
  });

  describe("user.deleted", () => {
    beforeEach(async () => {
      await applyClerkEvent(harness.db, {
        type: "organization.created",
        data: { id: "org_abc", name: "Test Diner" },
      });
      await applyClerkEvent(harness.db, {
        type: "organizationMembership.created",
        data: {
          organization: { id: "org_abc" },
          public_user_data: { user_id: "user_123", identifier: "m@example.com" },
        },
      });
    });

    it("sets deleted_at on the matching operator row", async () => {
      const outcome = await applyClerkEvent(harness.db, {
        type: "user.deleted",
        data: { id: "user_123" },
      });

      expect(outcome).toEqual({ kind: "operator.soft_deleted", clerkUserId: "user_123" });
      expect(harness.state.operators[0].deletedAt).toBeInstanceOf(Date);
    });

    it("is idempotent on replay", async () => {
      await applyClerkEvent(harness.db, { type: "user.deleted", data: { id: "user_123" } });
      const firstDeletedAt = harness.state.operators[0].deletedAt;
      await applyClerkEvent(harness.db, { type: "user.deleted", data: { id: "user_123" } });

      // The row still exists, still soft-deleted; we don't assert exact ts
      // equality because the second update legitimately rewrites the column.
      expect(harness.state.operators).toHaveLength(1);
      expect(harness.state.operators[0].deletedAt).toBeInstanceOf(Date);
      expect(firstDeletedAt).toBeInstanceOf(Date);
    });

    it("no-ops cleanly when the operator row is unknown", async () => {
      const outcome = await applyClerkEvent(harness.db, {
        type: "user.deleted",
        data: { id: "user_never_seen" },
      });
      expect(outcome.kind).toBe("operator.soft_deleted");
      // Original operator is untouched.
      expect(harness.state.operators[0].deletedAt).toBeNull();
    });
  });

  describe("organization.deleted", () => {
    beforeEach(async () => {
      await applyClerkEvent(harness.db, {
        type: "organization.created",
        data: { id: "org_abc", name: "Test Diner" },
      });
    });

    it("sets cancelled_at on the matching business row", async () => {
      const outcome = await applyClerkEvent(harness.db, {
        type: "organization.deleted",
        data: { id: "org_abc" },
      });
      expect(outcome).toEqual({ kind: "business.cancelled", clerkOrgId: "org_abc" });
      expect(harness.state.businesses[0].cancelledAt).toBeInstanceOf(Date);
    });

    it("is idempotent on replay", async () => {
      await applyClerkEvent(harness.db, {
        type: "organization.deleted",
        data: { id: "org_abc" },
      });
      await applyClerkEvent(harness.db, {
        type: "organization.deleted",
        data: { id: "org_abc" },
      });
      expect(harness.state.businesses).toHaveLength(1);
      expect(harness.state.businesses[0].cancelledAt).toBeInstanceOf(Date);
    });
  });

  describe("unknown event type", () => {
    it("is ignored cleanly without writing", async () => {
      const outcome = await applyClerkEvent(harness.db, {
        type: "session.created",
        data: { id: "sess_xxx" },
      });
      expect(outcome).toEqual({ kind: "ignored", type: "session.created" });
      expect(harness.state.businesses).toHaveLength(0);
      expect(harness.state.operators).toHaveLength(0);
    });
  });
});
