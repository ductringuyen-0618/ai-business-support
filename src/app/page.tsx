import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";

/**
 * Public marketing root.
 *
 * Slice 1 deliberately keeps this minimal — enough to prove the auth-gated
 * shell works. Marketing copy lands in a later slice.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">ai-business-support</h1>
        <p className="text-slate-600">
          Aggregate Reviews for your Business from external Sources, surface Themes and Incidents,
          and notify Operators.
        </p>
      </header>

      <section className="flex items-center gap-4">
        <SignedOut>
          <SignInButton mode="modal">
            <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-100">
              Create a Business
            </button>
          </SignUpButton>
        </SignedOut>
        <SignedIn>
          <Link
            href="/app/dashboard"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Open dashboard
          </Link>
          <UserButton afterSignOutUrl="/" />
        </SignedIn>
      </section>
    </main>
  );
}
