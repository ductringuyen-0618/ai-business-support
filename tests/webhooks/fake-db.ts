/**
 * Hand-rolled in-memory stand-in for the slice of Drizzle the webhook event
 * handlers use.
 *
 * Why not pg-mem / a real Neon test branch? At slice 2 the handler only touches
 * two tables, the operations are tiny, and the goal of the tests is to pin the
 * exact "upsert keyed on Clerk id" / "soft-delete idempotently" contract that
 * Clerk's retries depend on. A ~120-line in-memory store reads more clearly
 * than either alternative and runs in <100ms; we will switch to a real Postgres
 * test harness once we have FK-heavy joins to exercise.
 *
 * Coordination with `vi.mock("drizzle-orm")` in the test file: the mock
 * replaces `eq` and `sql` with the lightweight stand-ins exported here, so the
 * handler's `eq(...)` calls produce plain predicate functions and `sql\`now()\``
 * produces a sentinel that our update builders translate to `new Date()`.
 */
import { businesses, operators } from "@/db/schema";

type BusinessRow = typeof businesses.$inferSelect;
type OperatorRow = typeof operators.$inferSelect;

export interface FakeDbState {
  businesses: BusinessRow[];
  operators: OperatorRow[];
}

let uuidCounter = 0;
function nextUuid(prefix: string): string {
  uuidCounter += 1;
  return `${prefix}-${uuidCounter.toString().padStart(8, "0")}-0000-0000-0000-000000000000`;
}

type FakePredicate = (row: Record<string, unknown>) => boolean;

// `eq` and `sql` stand-ins exposed to the handler via vi.mock("drizzle-orm").

export function fakeEq(column: unknown, value: unknown): FakePredicate {
  // Drizzle column objects carry `.name` (SQL name). Map to TS keys our fake
  // rows actually use. If the column is something else (already a predicate
  // function, plain key), do a best-effort lookup.
  const sqlName =
    typeof column === "object" && column !== null && "name" in column
      ? String((column as { name: unknown }).name)
      : String(column);
  const keyMap: Record<string, string> = {
    clerk_org_id: "clerkOrgId",
    clerk_user_id: "clerkUserId",
    business_id: "businessId",
    id: "id",
  };
  const key = keyMap[sqlName] ?? sqlName;
  return (row) => row[key] === value;
}

// Sentinel returned by fake `sql` template — turned into `new Date()` by the
// update builders when written into a timestamp column.
export const FAKE_NOW = Symbol("fake-now");
export function fakeSql(_strings: TemplateStringsArray, ..._values: unknown[]): typeof FAKE_NOW {
  return FAKE_NOW;
}

/**
 * Build a fake `db` that satisfies the surface area of `getDb()` used by the
 * webhook handlers. We intentionally only implement the methods the handlers
 * touch — anything else throws so accidental drift is loud.
 */
export function makeFakeDb() {
  const state: FakeDbState = { businesses: [], operators: [] };

  function insert(table: unknown) {
    if (table === businesses) return insertBusinesses(state);
    if (table === operators) return insertOperators(state);
    throw new Error("fake-db: insert into unknown table");
  }

  function update(table: unknown) {
    if (table === businesses) return updateBusinesses(state);
    if (table === operators) return updateOperators(state);
    throw new Error("fake-db: update on unknown table");
  }

  function select(_columns?: unknown) {
    return {
      from(table: unknown) {
        if (table === operators) return selectOperators(state);
        if (table === businesses) return selectBusinesses(state);
        throw new Error("fake-db: select from unknown table");
      },
    };
  }

  return {
    state,
    db: { insert, update, select } as unknown as ReturnType<typeof import("@/db/client").getDb>,
  };
}

function insertBusinesses(state: FakeDbState) {
  return {
    values(v: Partial<BusinessRow>) {
      return {
        async onConflictDoUpdate(args: { target: unknown; set: Partial<BusinessRow> }) {
          const clerkOrgId = v.clerkOrgId!;
          const existing = state.businesses.find((b) => b.clerkOrgId === clerkOrgId);
          if (existing) {
            Object.assign(existing, normaliseBusiness(args.set));
            return;
          }
          state.businesses.push({
            id: nextUuid("biz"),
            clerkOrgId,
            name: v.name ?? "",
            industry: v.industry ?? null,
            createdAt: new Date(),
            cancelledAt: null,
          } satisfies BusinessRow);
        },
      };
    },
  };
}

function insertOperators(state: FakeDbState) {
  return {
    values(v: Partial<OperatorRow>) {
      return {
        async onConflictDoUpdate(args: { target: unknown; set: Partial<OperatorRow> }) {
          const clerkUserId = v.clerkUserId!;
          const existing = state.operators.find((o) => o.clerkUserId === clerkUserId);
          if (existing) {
            Object.assign(existing, normaliseOperator(args.set));
            return;
          }
          state.operators.push({
            id: nextUuid("op"),
            clerkUserId,
            businessId: v.businessId!,
            email: v.email ?? "",
            name: v.name ?? null,
            createdAt: new Date(),
            deletedAt: null,
          } satisfies OperatorRow);
        },
      };
    },
  };
}

function updateBusinesses(state: FakeDbState) {
  return {
    set(updates: Partial<BusinessRow>) {
      return {
        async where(predicate: FakePredicate) {
          for (const row of state.businesses) {
            if (predicate(row as unknown as Record<string, unknown>)) {
              Object.assign(row, normaliseBusiness(updates));
            }
          }
        },
      };
    },
  };
}

function updateOperators(state: FakeDbState) {
  return {
    set(updates: Partial<OperatorRow>) {
      return {
        async where(predicate: FakePredicate) {
          for (const row of state.operators) {
            if (predicate(row as unknown as Record<string, unknown>)) {
              Object.assign(row, normaliseOperator(updates));
            }
          }
        },
      };
    },
  };
}

function selectOperators(state: FakeDbState) {
  return {
    where(predicate: FakePredicate) {
      return {
        async limit(n: number) {
          return state.operators
            .filter((row) => predicate(row as unknown as Record<string, unknown>))
            .slice(0, n);
        },
      };
    },
  };
}

function selectBusinesses(state: FakeDbState) {
  return {
    where(predicate: FakePredicate) {
      return {
        async limit(n: number) {
          return state.businesses
            .filter((row) => predicate(row as unknown as Record<string, unknown>))
            .slice(0, n);
        },
      };
    },
  };
}

function normaliseBusiness(updates: Partial<BusinessRow>): Partial<BusinessRow> {
  const out: Partial<BusinessRow> = { ...updates };
  if ((out.cancelledAt as unknown) === FAKE_NOW) out.cancelledAt = new Date();
  return out;
}

function normaliseOperator(updates: Partial<OperatorRow>): Partial<OperatorRow> {
  const out: Partial<OperatorRow> = { ...updates };
  if ((out.deletedAt as unknown) === FAKE_NOW) out.deletedAt = new Date();
  return out;
}
