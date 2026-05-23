/**
 * Stub for the `@clerk/nextjs` client surface in E2E mode. Renders no-op
 * placeholders for `<ClerkProvider>`, `<UserButton>`, `<SignIn>`, `<SignUp>`,
 * `<SignedIn>`, `<SignedOut>`, etc. The Playwright spec doesn't drive any of
 * these widgets — auth is short-circuited via the request header — but the
 * components still need to render so the app shell mounts.
 */
import type { ReactNode } from "react";

interface ChildrenProps {
  children?: ReactNode;
}

export function ClerkProvider({ children }: ChildrenProps) {
  return <>{children}</>;
}

export function SignedIn({ children }: ChildrenProps) {
  return <>{children}</>;
}

export function SignedOut({ children: _children }: ChildrenProps) {
  // We are always "signed in" in E2E mode (the header carries identity).
  return null;
}

export function SignInButton({ children }: ChildrenProps) {
  return <button type="button">{children ?? "Sign in"}</button>;
}

export function SignUpButton({ children }: ChildrenProps) {
  return <button type="button">{children ?? "Sign up"}</button>;
}

export function UserButton(_props: { afterSignOutUrl?: string }) {
  return (
    <span aria-label="user-menu (e2e stub)" data-testid="e2e-user-button">
      user
    </span>
  );
}

export function SignIn(_props: Record<string, unknown>) {
  return <div data-testid="e2e-sign-in">Sign in (e2e stub)</div>;
}

export function SignUp(_props: Record<string, unknown>) {
  return <div data-testid="e2e-sign-up">Sign up (e2e stub)</div>;
}
