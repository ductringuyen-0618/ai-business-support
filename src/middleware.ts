/**
 * Clerk auth middleware.
 *
 * Every route under `/app/*` is auth-protected; unauthenticated visitors are
 * redirected to Clerk's hosted sign-in. The marketing root (`/`), sign-in/up
 * routes, and webhook endpoints stay public.
 */
import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/app(.*)"]);
// Public endpoints that Clerk itself (or other upstream systems) call. Must NOT
// require a signed-in user — Clerk's webhook delivery has no session cookie,
// it authenticates via Svix signature instead.
const isPublicRoute = createRouteMatcher(["/api/webhooks/(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  if (!isProtectedRoute(req)) return;

  const { userId } = await auth();
  if (!userId) {
    // Explicit redirect to Clerk's hosted sign-in catch-all so unauthenticated
    // visitors (incl. SSR / non-JS clients) land somewhere meaningful instead
    // of getting Clerk's default 404 rewrite.
    const signInUrl = new URL("/sign-in", req.url);
    signInUrl.searchParams.set("redirect_url", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  matcher: [
    // Run on every route except Next.js internals and static files,
    // but always run on API routes.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
