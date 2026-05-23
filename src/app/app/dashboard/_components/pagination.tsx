"use client";

/**
 * URL-based pager for the dashboard Review list (slice 12).
 *
 * Reads the current URL search params, bumps the `page` value, and pushes the
 * new URL. The server component re-reads on each render so this is the only
 * place that owns "what page am I on".
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface PaginationProps {
  page: number;
  total: number;
  perPage: number;
}

export function Pagination({ page, total, perPage }: PaginationProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/dashboard";
  const searchParams = useSearchParams();

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;

  function go(next: number) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next <= 1) params.delete("page");
    else params.set("page", String(next));
    const qs = params.toString();
    router.push(qs.length ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <nav
      className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600"
      aria-label="Review list pagination"
    >
      <button
        type="button"
        onClick={() => go(page - 1)}
        disabled={page <= 1}
        className="rounded-md px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
      >
        ← Previous
      </button>
      <span className="text-xs">
        Page {page} of {totalPages} · {total} Reviews
      </span>
      <button
        type="button"
        onClick={() => go(page + 1)}
        disabled={page >= totalPages}
        className="rounded-md px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
      >
        Next →
      </button>
    </nav>
  );
}
