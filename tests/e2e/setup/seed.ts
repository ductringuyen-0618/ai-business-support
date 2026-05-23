/**
 * DB-seeding helpers used by the happy-path spec. We connect directly to the
 * ephemeral Postgres with `postgres` (same driver Drizzle's worker side uses)
 * because pushing through the Next dev server would require a Clerk webhook
 * round-trip — and the webhook signing dance is itself out of scope for the
 * happy path.
 *
 * Each helper is idempotent so re-running the spec in `--retain-on-failure`
 * mode doesn't accumulate rows.
 */
import postgres from "postgres";

import { readRuntimeState } from "./runtime-state";

export interface SeededBusiness {
  businessId: string;
  operatorId: string;
  clerkUserId: string;
  clerkOrgId: string;
  operatorEmail: string;
  businessName: string;
}

/**
 * Seed a Business + Operator pair. Mirrors the rows Clerk's
 * `organization.created` + `organizationMembership.created` webhooks would
 * produce in production. We do it via direct SQL rather than driving the
 * webhook route because the webhook needs a valid Svix signature, and minting
 * one in-test is more ceremony than the slice's scope.
 */
export async function seedBusinessAndOperator(opts: {
  clerkUserId: string;
  clerkOrgId: string;
  operatorEmail: string;
  businessName: string;
}): Promise<SeededBusiness> {
  const state = readRuntimeState();
  const sql = postgres(state.databaseUrl, { max: 1 });
  try {
    const [bizRow] = await sql<{ id: string }[]>`
      INSERT INTO businesses (clerk_org_id, name)
      VALUES (${opts.clerkOrgId}, ${opts.businessName})
      ON CONFLICT (clerk_org_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    const businessId = bizRow.id;
    const [opRow] = await sql<{ id: string }[]>`
      INSERT INTO operators (clerk_user_id, business_id, email, name)
      VALUES (${opts.clerkUserId}, ${businessId}, ${opts.operatorEmail}, 'E2E Operator')
      ON CONFLICT (clerk_user_id) DO UPDATE SET
        business_id = EXCLUDED.business_id,
        email = EXCLUDED.email,
        deleted_at = NULL
      RETURNING id
    `;
    return {
      businessId,
      operatorId: opRow.id,
      clerkUserId: opts.clerkUserId,
      clerkOrgId: opts.clerkOrgId,
      operatorEmail: opts.operatorEmail,
      businessName: opts.businessName,
    };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/** Count rows in a given table for a Business — for assertions. */
export async function countRows(
  table: "reviews" | "classifications" | "incidents" | "source_connections" | "escalations",
  whereBusinessId?: string,
): Promise<number> {
  const state = readRuntimeState();
  const sql = postgres(state.databaseUrl, { max: 1 });
  try {
    if (!whereBusinessId) {
      const [row] = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM ${sql(table)}`;
      return row.c;
    }
    if (table === "reviews") {
      const [row] = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c
        FROM reviews r
        JOIN source_connections sc ON sc.id = r.source_connection_id
        WHERE sc.business_id = ${whereBusinessId}
      `;
      return row.c;
    }
    if (table === "classifications") {
      const [row] = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c
        FROM classifications cl
        JOIN reviews r ON r.id = cl.review_id
        JOIN source_connections sc ON sc.id = r.source_connection_id
        WHERE sc.business_id = ${whereBusinessId}
      `;
      return row.c;
    }
    if (table === "source_connections" || table === "incidents") {
      const [row] = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c
        FROM ${sql(table)}
        WHERE business_id = ${whereBusinessId}
      `;
      return row.c;
    }
    // escalations: scope via the joined Incident.
    const [row] = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c
      FROM escalations e
      JOIN incidents i ON i.id = e.incident_id
      WHERE i.business_id = ${whereBusinessId}
    `;
    return row.c;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/**
 * Wait for a SQL predicate to become true, polling every `intervalMs` until
 * `timeoutMs` elapses. Used to await the async pipeline (backfill → ingest →
 * classify → fire incident) from the spec.
 */
export async function waitForCondition(
  predicate: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 500;
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForCondition timed out after ${timeoutMs}ms: ${opts.label ?? "(no label)"}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
