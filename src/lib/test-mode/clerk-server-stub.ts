/**
 * Stub implementation of the `@clerk/nextjs/server` surface used by the app,
 * activated when Next is built with `E2E_TEST_MODE=1`. The whole module is
 * aliased over the real Clerk package via `next.config.ts`.
 *
 * Auth identity comes from the `x-e2e-clerk-user-id` header — the Playwright
 * spec sets this on every request via `page.setExtraHTTPHeaders`. Absent the
 * header, the user is "unauthenticated" (so middleware redirects work and we
 * can still test the unauthenticated path if we want to).
 *
 * The middleware passthrough is deliberately permissive: every request goes
 * straight to the route handler. We don't try to faithfully replay Clerk's
 * matcher logic here — the routes themselves enforce auth via `auth()` /
 * `currentUser()`, which read the same header.
 */
import { headers as nextHeaders } from "next/headers";

const E2E_USER_HEADER = "x-e2e-clerk-user-id";
const E2E_USER_FIRST_NAME_HEADER = "x-e2e-clerk-first-name";
const E2E_USER_USERNAME_HEADER = "x-e2e-clerk-username";
const E2E_USER_EMAIL_HEADER = "x-e2e-clerk-email";

type MatcherFn = (req: unknown) => boolean;

export function createRouteMatcher(_patterns: string[]): MatcherFn {
  // We don't need real matching — the auth check in each handler resolves
  // identity from the same header, so middleware can be a pure passthrough.
  return () => false;
}

/**
 * Passthrough middleware. The real `clerkMiddleware` performs redirect-to-
 * sign-in when a protected route is hit unauthenticated; in test mode the
 * spec always sets the header before navigating to /app/*, so the redirect
 * path isn't exercised.
 *
 * Returns a NextMiddleware-compatible signature (req, ev) => Response | void.
 */
export function clerkMiddleware(_handler: unknown) {
  return () => undefined;
}

async function readHeader(name: string): Promise<string | null> {
  const h = await nextHeaders();
  return h.get(name);
}

export async function auth(): Promise<{ userId: string | null }> {
  const userId = await readHeader(E2E_USER_HEADER);
  return { userId };
}

export interface FakeClerkUser {
  id: string;
  firstName: string | null;
  username: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
}

export async function currentUser(): Promise<FakeClerkUser | null> {
  const userId = await readHeader(E2E_USER_HEADER);
  if (!userId) return null;
  const firstName = await readHeader(E2E_USER_FIRST_NAME_HEADER);
  const username = await readHeader(E2E_USER_USERNAME_HEADER);
  const email = await readHeader(E2E_USER_EMAIL_HEADER);
  return {
    id: userId,
    firstName: firstName ?? null,
    username: username ?? null,
    primaryEmailAddress: email ? { emailAddress: email } : null,
  };
}
