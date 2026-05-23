import { SignIn } from "@clerk/nextjs";

/** Clerk-hosted sign-in catch-all route. */
export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <SignIn />
    </main>
  );
}
