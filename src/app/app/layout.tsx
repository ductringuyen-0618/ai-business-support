import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

/**
 * Authenticated app shell. Anything under /app/* lives inside this layout
 * and is gated by Clerk middleware in `src/middleware.ts`.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <Link href="/app/dashboard" className="text-sm font-semibold tracking-tight">
              ai-business-support
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-600">
              <Link href="/app/dashboard" className="hover:text-slate-900">
                Dashboard
              </Link>
              <Link href="/app/settings/channels" className="hover:text-slate-900">
                Channels
              </Link>
            </nav>
          </div>
          <UserButton afterSignOutUrl="/" />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
