"use client";

/**
 * Dashboard helpers for the Google connect/disconnect controls + flash toast.
 *
 * These live as a client component because:
 *   - The disconnect button needs to POST then refresh the route. A server
 *     action would also work, but a small fetch + router.refresh() keeps the
 *     contract (`POST /api/sources/:id/disconnect → 204`) testable on its own.
 *   - The flash toast uses `useEffect` to clear the `?flash=` query param
 *     after first render so a refresh doesn't re-show it.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export function ConnectGoogleButton() {
  return (
    <a
      href="/api/sources/google/oauth/start"
      className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-slate-800"
    >
      Connect Google
    </a>
  );
}

export function DisconnectGoogleButton({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const resp = await fetch(`/api/sources/${connectionId}/disconnect`, { method: "POST" });
      if (!resp.ok && resp.status !== 204) {
        // Best-effort surface — the dashboard will re-render with the
        // (still-connected) row so the operator sees the action didn't take.
        console.error("[dashboard] disconnect failed:", resp.status);
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
    >
      {busy ? "Disconnecting…" : "Disconnect"}
    </button>
  );
}

/**
 * Render a one-shot success/failure banner from the `?flash=` query param,
 * then clear it from the URL on next tick so refreshing the dashboard
 * doesn't re-show the toast.
 */
export function DashboardFlash({ flash }: { flash: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [active, setActive] = useState<string | null>(flash);

  useEffect(() => {
    if (!flash) return;
    setActive(flash);
    // Strip the query param from the URL without triggering a server roundtrip.
    const next = new URLSearchParams(searchParams?.toString());
    next.delete("flash");
    const qs = next.toString();
    const url = qs.length ? `?${qs}` : "";
    router.replace(`/app/dashboard${url}`, { scroll: false });
  }, [flash, router, searchParams]);

  if (!active) return null;

  const messages: Record<string, { tone: "success" | "error"; text: string }> = {
    google_connected: {
      tone: "success",
      text: "Google Business Profile connected. We're backfilling your reviews — refresh in a few minutes.",
    },
    google_state_mismatch: {
      tone: "error",
      text: "Connection request failed a security check. Please try connecting again.",
    },
    google_exchange_failed: {
      tone: "error",
      text: "We couldn't finish the Google connection. Please try again.",
    },
  };
  const m = messages[active];
  if (!m) return null;

  const tone =
    m.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : "border-red-200 bg-red-50 text-red-900";
  return (
    <div role="status" className={`rounded-md border px-4 py-3 text-sm ${tone}`}>
      {m.text}
    </div>
  );
}
