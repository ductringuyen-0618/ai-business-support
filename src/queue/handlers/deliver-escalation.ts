/**
 * `deliver_escalation` job handler (slice 11, issue #12).
 *
 * Loads the Escalation + joined Incident/Review/Classification/Business,
 * renders a payload per Channel, sends it through the Channel wrapper
 * (Resend for Email, Twilio for SMS), and flips `escalations.status`.
 *
 * On transient failure (Resend/Twilio 5xx or network error) we let the throw
 * propagate so pg-boss reschedules a retry per `DELIVER_ESCALATION_RETRY`.
 * After retries exhaust, pg-boss's `onComplete`-style failure isn't directly
 * reachable from our `work()` callback signature; instead we mark `failed`
 * inline if the job's `retrycount` is at the final attempt, so the
 * `escalations` row's `status` is the source of truth even after pg-boss
 * gives up. We also swallow the throw on the final attempt so pg-boss
 * doesn't surface it as an unhandled exception.
 *
 * Email body presents the LLM-drafted Reply as a draft for the Operator to
 * paste manually into Google (ADR-0003) — we do NOT auto-post. The Operator
 * sees the REAL Reviewer name and the REAL Review text; redaction was only
 * for the Anthropic call.
 */
import type { JobWithMetadata } from "pg-boss";

import {
  findEscalationContext as findEscalationContextDefault,
  markEscalationFailed as markEscalationFailedDefault,
  markEscalationSent as markEscalationSentDefault,
  type EscalationContext,
} from "@/db/queries/escalations";
import { sendEmail as sendEmailDefault } from "@/lib/email/resend";
import { sendSms as sendSmsDefault } from "@/lib/sms/twilio";

import type { DeliverEscalationPayload } from "../boss";
import { DELIVER_ESCALATION_RETRY } from "../boss";

export { DELIVER_ESCALATION_JOB, type DeliverEscalationPayload } from "../boss";

/**
 * Dependency-injection seam. Mirrors the other handlers — tests pass fakes
 * so we can exercise the rendering + status flips without standing up
 * Resend/Twilio/Postgres.
 */
export interface DeliverEscalationDeps {
  findEscalationContext: typeof findEscalationContextDefault;
  markEscalationSent: typeof markEscalationSentDefault;
  markEscalationFailed: typeof markEscalationFailedDefault;
  sendEmail: typeof sendEmailDefault;
  sendSms: typeof sendSmsDefault;
}

export const DEFAULT_DELIVER_ESCALATION_DEPS: DeliverEscalationDeps = {
  findEscalationContext: findEscalationContextDefault,
  markEscalationSent: markEscalationSentDefault,
  markEscalationFailed: markEscalationFailedDefault,
  sendEmail: sendEmailDefault,
  sendSms: sendSmsDefault,
};

export async function handleDeliverEscalation(
  jobs: JobWithMetadata<DeliverEscalationPayload>[],
  deps: DeliverEscalationDeps = DEFAULT_DELIVER_ESCALATION_DEPS,
): Promise<void> {
  for (const job of jobs) {
    await processOne(job, deps);
  }
}

async function processOne(
  job: JobWithMetadata<DeliverEscalationPayload>,
  deps: DeliverEscalationDeps,
): Promise<void> {
  const { escalation_id: escalationId } = job.data;
  const ctx = await deps.findEscalationContext(escalationId);
  if (!ctx) {
    console.warn(
      `[deliver_escalation] escalation ${escalationId} not found; abandoning job ${job.id}`,
    );
    return;
  }
  if (ctx.escalation.status === "sent") {
    // Idempotency: a re-delivered job for an already-sent Escalation should
    // not double-send.
    return;
  }

  try {
    if (ctx.escalation.channel === "email") {
      await sendEmailForEscalation(ctx, deps);
    } else {
      await sendSmsForEscalation(ctx, deps);
    }
    await deps.markEscalationSent(escalationId);
  } catch (err) {
    // pg-boss's `retrycount` is 0-indexed: the FIRST attempt has retrycount=0,
    // the retryLimit-th retry has retrycount=retryLimit. When we're on the
    // final attempt we mark the Escalation failed and swallow so pg-boss
    // doesn't keep retrying past the limit.
    const isFinalAttempt = (job.retryCount ?? 0) >= DELIVER_ESCALATION_RETRY.retryLimit;
    if (isFinalAttempt) {
      console.error(
        `[deliver_escalation] final attempt failed for escalation ${escalationId}; marking failed:`,
        err,
      );
      await deps.markEscalationFailed(escalationId);
      return; // do not re-throw — pg-boss is out of retries anyway
    }
    console.warn(
      `[deliver_escalation] transient failure for escalation ${escalationId} (attempt ${
        job.retryCount ?? 0
      }); pg-boss will retry:`,
      err,
    );
    throw err;
  }
}

async function sendEmailForEscalation(
  ctx: EscalationContext,
  deps: DeliverEscalationDeps,
): Promise<void> {
  const subject = `[${ctx.business.name}] New Incident — ${ctx.incident.severity}`;
  const html = renderEmailHtml(ctx);
  await deps.sendEmail({
    to: [ctx.operator.email],
    subject,
    html,
  });
}

async function sendSmsForEscalation(
  ctx: EscalationContext,
  deps: DeliverEscalationDeps,
): Promise<void> {
  const phone = ctx.operatorPref?.phoneE164;
  if (!phone) {
    // We refuse to send an SMS to no-one. This would only happen if SMS was
    // enabled then the phone number column was nulled out of band — not
    // worth retrying.
    throw new Error(
      `deliver_escalation: SMS channel enabled but no verified phone number on operator_channel_prefs for operator=${ctx.operator.id}`,
    );
  }
  const body = renderSmsBody(ctx);
  await deps.sendSms({ to: phone, body });
}

/**
 * Email body presents the Reply as a draft per ADR-0003: framed for the
 * Operator to review and post manually via Google. Real Reviewer name and
 * Review text are shown (Operator-side; the redaction was only for Anthropic).
 *
 * Exported for the unit tests + future Storybook-style snapshot tests.
 */
export function renderEmailHtml(ctx: EscalationContext): string {
  const appBase = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const dashboardLink = `${appBase}/app/dashboard?incident=${encodeURIComponent(ctx.incident.id)}`;
  const reviewerName = htmlEscape(ctx.review.reviewerDisplayName ?? "Anonymous Reviewer");
  const reviewText = htmlEscape(ctx.review.reviewText ?? "(no review text — star rating only)");
  const stars = "★".repeat(ctx.review.starRating) + "☆".repeat(5 - ctx.review.starRating);
  const themes = ctx.classification?.themes ?? [];
  const themePills = themes
    .map(
      (t) =>
        `<span style="display:inline-block;background:#eef2ff;color:#3730a3;padding:2px 8px;border-radius:999px;font-size:12px;margin-right:4px;">${htmlEscape(
          t,
        )}</span>`,
    )
    .join("");
  const suggestedReply = htmlEscape(ctx.classification?.suggestedReply ?? "");

  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a; max-width: 600px; margin: 0 auto; padding: 24px;">
    <h1 style="font-size: 18px; margin: 0 0 4px;">New Incident at ${htmlEscape(ctx.business.name)}</h1>
    <p style="color:#64748b; margin: 0 0 16px; font-size: 13px;">Severity: <strong>${htmlEscape(
      ctx.incident.severity,
    )}</strong></p>

    <div style="border:1px solid #e2e8f0; border-radius: 8px; padding: 16px; background: #f8fafc; margin-bottom: 16px;">
      <p style="margin:0 0 8px; font-weight: 600;">${reviewerName}
        <span style="color:#eab308; font-weight: normal; margin-left:6px;">${stars}</span>
      </p>
      ${themePills ? `<p style="margin: 0 0 12px;">${themePills}</p>` : ""}
      <p style="margin: 0; white-space: pre-wrap;">${reviewText}</p>
    </div>

    <h2 style="font-size: 14px; margin: 16px 0 8px;">Suggested reply (draft)</h2>
    <p style="color:#64748b; font-size: 12px; margin: 0 0 8px;">
      Here&apos;s a suggested reply — review and post via Google manually.
    </p>
    <pre style="white-space: pre-wrap; background:#fff; border:1px solid #e2e8f0; border-radius: 8px; padding: 16px; font-family: inherit; margin: 0 0 16px;">${suggestedReply}</pre>

    <p style="margin: 24px 0 0;">
      <a href="${dashboardLink}" style="background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size: 14px;">
        Open in dashboard
      </a>
    </p>
  </body>
</html>`;
}

/**
 * SMS body. Targets ≤ 320 chars (2 SMS segments) so deliverability stays
 * predictable. We include the severity, the Business name, the first 120 chars
 * of the Review (truncated with an ellipsis), and the dashboard link.
 *
 * Exported for the unit tests.
 */
export function renderSmsBody(ctx: EscalationContext): string {
  const appBase = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const link = `${appBase}/app/dashboard?incident=${ctx.incident.id}`;
  const severity = ctx.incident.severity.toUpperCase();
  const business = ctx.business.name;
  const raw = ctx.review.reviewText ?? "(star-only review)";
  const snippet = raw.length > 120 ? raw.slice(0, 117) + "..." : raw;
  const body = `[${severity}] ${business}: ${snippet}\n\n${link}`;
  // Hard ceiling — if a Business + Review text combo pushes past 320, trim
  // the snippet further.
  if (body.length <= 320) return body;
  const overshoot = body.length - 320;
  const trimmedSnippet =
    snippet.length > overshoot + 3
      ? snippet.slice(0, snippet.length - overshoot - 3) + "..."
      : "...";
  return `[${severity}] ${business}: ${trimmedSnippet}\n\n${link}`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
