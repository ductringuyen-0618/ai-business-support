/**
 * "Your dashboard is ready" email — sent once per SourceConnection by the
 * `backfill_source` handler when `loaded_count >= 0.95 * estimated_total`.
 * See ADR-0007 for the product rationale.
 *
 * This file is intentionally a thin direct call into the Resend SDK rather
 * than the general Channel-Email sender (`src/lib/email/resend.ts`) — slice
 * 11 owns the latter and a coordinator pass will consolidate. Keeping the
 * two senders side-by-side here is a knowing duplication that lets slices
 * 10 and 11 ship in parallel.
 *
 * Dependency injection: `Sender` is the seam tests use to substitute a fake.
 * Production callers pass nothing and get the real Resend client.
 */
import { Resend } from "resend";

export interface BackfillReadyEmailInput {
  to: string[];
  businessName: string;
  /** Number of historical Reviews loaded — surfaced in the email body. */
  reviewCount: number;
  /** Deep-link the Operator into their dashboard. */
  appBaseUrl?: string;
}

/**
 * Minimum interface the sender needs from `resend`. Mocking the entire SDK
 * surface in tests would be overkill — `send` is all we touch.
 */
export interface ResendLike {
  emails: {
    send: (args: { from: string; to: string[]; subject: string; html: string }) => Promise<unknown>;
  };
}

/**
 * Build the default Resend client lazily so importing this module at module-
 * eval time (vitest discovery) doesn't crash when `RESEND_API_KEY` isn't set.
 */
function defaultResend(): ResendLike {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "sendBackfillReadyEmail: RESEND_API_KEY is not set; cannot send the dashboard-ready email.",
    );
  }
  return new Resend(apiKey);
}

function defaultFromAddress(): string {
  // Slice 11 will introduce a shared `EMAIL_FROM_ADDRESS` env var; until then
  // we hard-code a sensible default that mirrors what slice 11 is expected to
  // use. The coordinator pass at rebase time will unify these.
  return process.env.EMAIL_FROM_ADDRESS ?? "ai-business-support <onboarding@resend.dev>";
}

/**
 * Send the one-shot "ready" email. Throws on Resend errors so the caller (the
 * backfill handler) can decide whether to mark the connection complete anyway
 * — current behaviour: we set the `ready_email_sent_at` BEFORE the send is
 * attempted (atomic db update), so a send failure surfaces a transient
 * outage that pg-boss retries up to its limit; the row stays marked so the
 * email isn't double-sent on retry. (See the handler's call site for the
 * exact ordering.)
 */
export async function sendBackfillReadyEmail(
  input: BackfillReadyEmailInput,
  client: ResendLike = defaultResend(),
): Promise<void> {
  const appUrl = input.appBaseUrl ?? process.env.APP_BASE_URL ?? "http://localhost:3000";
  const subject = `${input.businessName}: your dashboard is ready`;
  const html = `
    <p>Hi,</p>
    <p>
      We've finished loading the historical Reviews for <strong>${escapeHtml(
        input.businessName,
      )}</strong> —
      <strong>${input.reviewCount}</strong> Review${input.reviewCount === 1 ? "" : "s"} processed.
    </p>
    <p>
      Your trends, Themes, and Incident feed are now populated. Open the
      dashboard to take a look:
    </p>
    <p><a href="${appUrl}/app/dashboard">${appUrl}/app/dashboard</a></p>
    <p>— ai-business-support</p>
  `.trim();

  await client.emails.send({
    from: defaultFromAddress(),
    to: input.to,
    subject,
    html,
  });
}

/**
 * Minimal HTML escape for the Business name interpolation. We do NOT use a
 * full templating library here — the surface area is one variable and a
 * dependency is overkill.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
