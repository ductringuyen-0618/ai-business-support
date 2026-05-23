/**
 * `GET /api/sources/google/oauth/callback?code=...&state=...`
 *
 * Thin adapter that turns the Next.js request into a `CallbackInput`, calls
 * the testable `handleGoogleOAuthCallback`, and translates the outcome into a
 * 302 redirect + cookie clear. See `./handler.ts` for the actual logic.
 *
 * Flash semantics: we use a `?flash=` query param on the dashboard URL rather
 * than a cookie because (a) it's one-shot by design (refresh clears it), and
 * (b) it survives the Vercel edge → React server-component handoff without
 * needing per-request state.
 */
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { OAUTH_STATE_COOKIE } from "@/lib/source-tokens/oauth-state";

import { handleGoogleOAuthCallback } from "./handler";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { userId } = await auth();

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  // `request.headers.get('cookie')` parsing — Next 15's `cookies()` works in
  // route handlers, but reading the raw header avoids importing from
  // `next/headers` in a way that wouldn't be testable from the handler file.
  const stateCookie = readCookie(request.headers.get("cookie"), OAUTH_STATE_COOKIE);

  const outcome = await handleGoogleOAuthCallback({
    clerkUserId: userId ?? null,
    code,
    stateParam,
    stateCookie,
  });

  // All branches clear the state cookie — it's single-use.
  const clearStateCookie = (response: NextResponse) => {
    response.cookies.set({
      name: OAUTH_STATE_COOKIE,
      value: "",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  };

  switch (outcome.kind) {
    case "redirect-sign-in":
      return clearStateCookie(NextResponse.redirect(new URL("/sign-in", request.url)));
    case "redirect-dashboard": {
      const target = new URL("/app/dashboard", request.url);
      target.searchParams.set("flash", outcome.flash);
      return clearStateCookie(NextResponse.redirect(target, { status: 302 }));
    }
    case "ok": {
      const target = new URL("/app/dashboard", request.url);
      target.searchParams.set("flash", "google_connected");
      return clearStateCookie(NextResponse.redirect(target, { status: 302 }));
    }
  }
}

/**
 * Read a single cookie value from a raw `Cookie:` header. Returns `null` if
 * the header is absent or the cookie isn't present. We don't use the global
 * `cookie` package — there's exactly one cookie we care about here and a
 * regex is sufficient.
 */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  // Find `name=...` bounded by `;` or string start/end.
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const re = new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`);
  const match = re.exec(header);
  return match ? decodeURIComponent(match[1]) : null;
}
