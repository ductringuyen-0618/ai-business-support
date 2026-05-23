/**
 * Clerk webhook event handlers.
 *
 * Pure functions that take a parsed Clerk event payload and a Drizzle DB
 * instance and apply the corresponding row mutations. Kept transport-agnostic
 * so the route handler stays small and tests can drive these directly with a
 * test DB (or a stubbed `DbLike`).
 *
 * Idempotency: every write goes through `onConflictDoUpdate` keyed on the
 * relevant Clerk identifier (`clerk_org_id` / `clerk_user_id`). Replaying the
 * same Clerk event (Clerk retries on non-2xx) is therefore a no-op beyond
 * touching `updated_at`-style fields, which we don't have yet.
 *
 * Per ADR-0009 we map Clerk Organization → Business and Clerk user → Operator.
 */
import { eq, sql } from "drizzle-orm";

import { businesses, operators } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

// ---- Event payload shapes (subset we use). -----------------------------------
//
// We deliberately type only the fields we read. Clerk events carry more, but
// pinning to the bits we need keeps the contract obvious and surfaces breaking
// upstream changes as TypeScript errors instead of silent runtime drift.

export interface OrganizationCreatedEvent {
  type: "organization.created" | "organization.updated";
  data: {
    id: string;
    name: string;
    // `public_metadata.industry` is the agreed lane for Operators to declare
    // their vertical at signup (used by the Playbook selector in later slices).
    public_metadata?: { industry?: string | null } | null;
  };
}

export interface OrganizationDeletedEvent {
  type: "organization.deleted";
  data: { id: string };
}

export interface OrganizationMembershipCreatedEvent {
  type: "organizationMembership.created" | "organizationMembership.updated";
  data: {
    organization: { id: string };
    public_user_data: {
      user_id: string;
      identifier?: string | null;
      first_name?: string | null;
      last_name?: string | null;
    };
  };
}

export interface UserDeletedEvent {
  type: "user.deleted";
  data: { id: string };
}

export type ClerkEvent =
  | OrganizationCreatedEvent
  | OrganizationDeletedEvent
  | OrganizationMembershipCreatedEvent
  | UserDeletedEvent
  // Events we know about but ignore for now — kept in the union so the switch
  // is exhaustive and ignored events return cleanly instead of throwing.
  | { type: string; data: unknown };

export type EventOutcome =
  | { kind: "business.upserted"; clerkOrgId: string }
  | { kind: "business.cancelled"; clerkOrgId: string }
  | { kind: "operator.upserted"; clerkUserId: string; clerkOrgId: string }
  | { kind: "operator.soft_deleted"; clerkUserId: string }
  | { kind: "ignored"; type: string };

/**
 * Apply a single Clerk event to the local DB. Idempotent.
 *
 * Throws if the event payload is missing required fields — the route handler
 * turns that into a 400 so Clerk records the failure and retries (which we
 * want, since malformed-and-then-fixed retries should heal the row).
 */
export async function applyClerkEvent(db: Db, event: ClerkEvent): Promise<EventOutcome> {
  switch (event.type) {
    case "organization.created":
    case "organization.updated":
      return upsertBusiness(db, event as OrganizationCreatedEvent);
    case "organization.deleted":
      return cancelBusiness(db, event as OrganizationDeletedEvent);
    case "organizationMembership.created":
    case "organizationMembership.updated":
      return upsertOperator(db, event as OrganizationMembershipCreatedEvent);
    case "user.deleted":
      return softDeleteOperator(db, event as UserDeletedEvent);
    default:
      return { kind: "ignored", type: event.type };
  }
}

async function upsertBusiness(db: Db, event: OrganizationCreatedEvent): Promise<EventOutcome> {
  const clerkOrgId = event.data?.id;
  const name = event.data?.name;
  if (!clerkOrgId || typeof name !== "string") {
    throw new WebhookPayloadError(`organization.${event.type} missing id or name`);
  }
  const industry = event.data?.public_metadata?.industry ?? null;
  await db
    .insert(businesses)
    .values({ clerkOrgId, name, industry })
    .onConflictDoUpdate({
      target: businesses.clerkOrgId,
      set: { name, industry, cancelledAt: null },
    });
  return { kind: "business.upserted", clerkOrgId };
}

async function cancelBusiness(db: Db, event: OrganizationDeletedEvent): Promise<EventOutcome> {
  const clerkOrgId = event.data?.id;
  if (!clerkOrgId) {
    throw new WebhookPayloadError("organization.deleted missing id");
  }
  // Setting `cancelled_at` starts the 30-day grace clock from ADR-0006.
  // The actual data purge lives in a later slice's scheduled job.
  await db
    .update(businesses)
    .set({ cancelledAt: sql`now()` })
    .where(eq(businesses.clerkOrgId, clerkOrgId));
  return { kind: "business.cancelled", clerkOrgId };
}

async function upsertOperator(
  db: Db,
  event: OrganizationMembershipCreatedEvent,
): Promise<EventOutcome> {
  const clerkOrgId = event.data?.organization?.id;
  const userData = event.data?.public_user_data;
  const clerkUserId = userData?.user_id;
  const email = userData?.identifier ?? null;
  if (!clerkOrgId || !clerkUserId || !email) {
    throw new WebhookPayloadError(
      "organizationMembership.created missing organization.id / user_id / identifier",
    );
  }

  // The Business must already exist locally for the FK. In practice Clerk fires
  // `organization.created` first, but if delivery ordering ever swaps we let
  // the lookup fail explicitly so Clerk retries — preferable to silently
  // dropping the Operator.
  const businessRows = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.clerkOrgId, clerkOrgId))
    .limit(1);
  const business = businessRows[0];
  if (!business) {
    throw new WebhookPayloadError(
      `organizationMembership.created for unknown business clerk_org_id=${clerkOrgId}`,
    );
  }

  const name = joinName(userData.first_name, userData.last_name);

  await db
    .insert(operators)
    .values({
      clerkUserId,
      businessId: business.id,
      email,
      name,
    })
    .onConflictDoUpdate({
      target: operators.clerkUserId,
      set: {
        businessId: business.id,
        email,
        name,
        // Re-activate if a previously soft-deleted Operator rejoins.
        deletedAt: null,
      },
    });

  return { kind: "operator.upserted", clerkUserId, clerkOrgId };
}

async function softDeleteOperator(db: Db, event: UserDeletedEvent): Promise<EventOutcome> {
  const clerkUserId = event.data?.id;
  if (!clerkUserId) {
    throw new WebhookPayloadError("user.deleted missing id");
  }
  await db
    .update(operators)
    .set({ deletedAt: sql`now()` })
    .where(eq(operators.clerkUserId, clerkUserId));
  return { kind: "operator.soft_deleted", clerkUserId };
}

function joinName(first?: string | null, last?: string | null): string | null {
  const joined = [first, last].filter((s): s is string => !!s && s.trim().length > 0).join(" ");
  return joined.length > 0 ? joined : null;
}

export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}
