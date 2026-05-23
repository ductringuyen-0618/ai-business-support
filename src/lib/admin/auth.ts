/**
 * Admin gate for internal-only endpoints.
 *
 * "Admin" here means us — the team running the SaaS — not an Operator. Operator
 * access flows through Clerk Organizations and is checked at the `/app/*` route
 * boundary; admin access flows through this module and is checked at
 * `/api/internal/*`.
 *
 * The admin list is a comma-separated env var (`ADMIN_USER_IDS`) of Clerk user
 * IDs. We deliberately keep this hardcoded in env rather than a DB role table
 * because the set is tiny (us), changes only on hiring/firing, and we never
 * want a SQL injection or DB outage to silently widen the admin gate.
 *
 * Dual-auth: the deletion-request endpoint also accepts a header-key shortcut
 * (see `src/app/api/internal/deletion-request/route.ts`) so a CLI / support
 * tool can call it without a Clerk session. The header-key check is separate
 * from this module — `isAdmin()` only covers the Clerk-session path.
 */

/**
 * Parse `ADMIN_USER_IDS` into a Set on every call. We re-read each time rather
 * than caching at module-load so tests can mutate the env var per-test without
 * a module reset, and so a production rotation takes effect on next request.
 */
function adminUserIds(): Set<string> {
  const raw = process.env.ADMIN_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Return true iff `clerkUserId` is non-null AND appears in `ADMIN_USER_IDS`.
 *
 * Note we accept `string | null` directly — Clerk's `auth()` returns
 * `{ userId: string | null }`, so callers can pass that field through without
 * an extra null-check.
 */
export function isAdmin(clerkUserId: string | null): boolean {
  if (!clerkUserId) return false;
  return adminUserIds().has(clerkUserId);
}
