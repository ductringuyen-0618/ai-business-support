/**
 * `POST /api/internal/deletion-request`
 *
 * Admin-only endpoint that honours a Reviewer's Deletion Request by nulling
 * `reviewer_display_name` and `review_text` on every matching Review row in a
 * single Business. The Classification row is left intact so trend reporting
 * keeps working (CONTEXT.md "Deletion Request", ADR-0006).
 *
 * --- Auth (dual mode) ---
 *
 * Production day-to-day: support staff run `scripts/deletion-request.ts`,
 * which presents an `X-Internal-Admin-Key: <key>` header signed against the
 * `INTERNAL_ADMIN_KEY` env var. This avoids dragging a Clerk session through
 * the CLI for a small fixed set of admins.
 *
 * Browser / debugging: if a Clerk-authenticated user hits this endpoint and
 * their user id is in `ADMIN_USER_IDS`, the call is also accepted. This is
 * the path used for ad-hoc admin tooling (e.g. an internal dashboard, slice
 * out-of-scope, listed under follow-ups in the runbook).
 *
 * NEITHER path requires the caller to be an Operator at the target Business;
 * admins are NOT Operators (CONTEXT.md). That's why this route lives under
 * `/api/internal/*` rather than `/app/*`.
 *
 * --- Tenant safety ---
 *
 * Even admins can only act inside ONE Business per call — `business_id` is
 * required. The `nullReviewerByBusiness` helper enforces this in the SQL
 * predicate (via source_connections JOIN), so a stray Review at a different
 * Business that happens to share the Reviewer's display name is never
 * touched. The Slice 15 tests cover this explicitly.
 *
 * --- Request body ---
 *
 *   { business_id: string;
 *     reviewer_display_name?: string;
 *     source_review_ids?: string[] }
 *
 * EXACTLY ONE of `reviewer_display_name` / `source_review_ids` must be set
 * (XOR — 400 otherwise). `source_review_ids` is the platform-side IDs
 * (`reviews.source_review_id`), NOT our internal `reviews.id` — it's what the
 * Reviewer's "delete THIS one in particular" request typically contains.
 *
 * --- Response ---
 *
 *   { affected: number; business_id: string; matched_review_ids: string[] }
 *
 * Idempotency: see `nullReviewerByBusiness` doc — a second invocation returns
 * the same `affected` count because the WHERE clause re-matches the same
 * rows; the SET-to-NULL is a no-op on already-null columns.
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { nullReviewerByBusiness } from "@/db/queries/reviews";
import { isAdmin } from "@/lib/admin/auth";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z
  .object({
    business_id: z.string().regex(UUID_RE, "business_id must be a UUID"),
    reviewer_display_name: z.string().min(1).optional(),
    source_review_ids: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const ADMIN_KEY_HEADER = "x-internal-admin-key";

/**
 * Check whether either auth path (admin Clerk session OR header key) accepts
 * this request. Returns true on accept. The two paths are checked
 * independently so a misconfigured `INTERNAL_ADMIN_KEY` doesn't lock out the
 * browser path, and vice versa.
 */
async function isAuthorised(request: Request): Promise<boolean> {
  // Path 1: header key.
  const providedKey = request.headers.get(ADMIN_KEY_HEADER);
  const expectedKey = process.env.INTERNAL_ADMIN_KEY;
  if (
    providedKey &&
    expectedKey &&
    expectedKey.length > 0 &&
    constantTimeEqual(providedKey, expectedKey)
  ) {
    return true;
  }

  // Path 2: Clerk session + admin allowlist. We only call `auth()` if the
  // header path didn't authenticate, so CLI traffic doesn't pay the cost.
  try {
    const { userId } = await auth();
    if (isAdmin(userId)) return true;
  } catch {
    // `auth()` throws when called outside a Clerk-instrumented request; the
    // header-key path is the supported way to call this endpoint without a
    // session, so swallow and fall through to a 403.
  }
  return false;
}

/**
 * Length-checked constant-time string compare. Avoids leaking the admin key's
 * length / prefix through timing of a naive `===`. Both args are user input
 * (header) and config (env), neither is sensitive at the bit level, but it's
 * cheap to do right.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await isAuthorised(request))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { business_id, reviewer_display_name, source_review_ids } = parsed.data;

  const hasName = reviewer_display_name !== undefined;
  const hasIds = source_review_ids !== undefined;
  if (hasName === hasIds) {
    return NextResponse.json(
      {
        error:
          "exactly one of reviewer_display_name or source_review_ids must be provided (not both, not neither)",
      },
      { status: 400 },
    );
  }

  const result = await nullReviewerByBusiness({
    businessId: business_id,
    reviewerDisplayName: reviewer_display_name,
    sourceReviewIds: source_review_ids,
  });

  return NextResponse.json({
    affected: result.affected,
    business_id,
    matched_review_ids: result.matchedIds,
  });
}
