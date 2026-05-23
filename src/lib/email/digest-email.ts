/**
 * Render the weekly Digest email body (slice 14).
 *
 * Pure function — no I/O. The `compose_digest` handler calls this with the
 * structured `DigestBody` produced by the Composer and the email-shell
 * metadata (Business name, period, dashboard URL) and then passes the HTML
 * to `sendEmail()` from `src/lib/email/resend.ts`.
 *
 * Layout choices:
 *   - Inline CSS only — most email clients silently drop `<style>` blocks.
 *   - Three sections: header, Theme movement, Pattern cards. CTA at the
 *     bottom links to the dashboard's Trends tab pre-filtered to this week.
 *   - No external assets — keeps the email portable across clients and
 *     avoids tracking-pixel concerns.
 */
import type { DigestBody } from "@/db/schema";

export interface RenderDigestEmailInput {
  businessName: string;
  /** Start of the 7-day window (UTC instant), used for the header + CTA URL. */
  periodStart: Date;
  /** End of the 7-day window (UTC instant, exclusive). */
  periodEnd: Date;
  body: DigestBody;
  /**
   * URL of the app's dashboard root. The renderer appends
   * `?since=<periodStart>&until=<periodEnd>` so the Trends tab opens already
   * filtered to the Digest's window. The shape `?since=ISO&until=ISO` is the
   * coordinated URL filter format with slice 12's dashboard.
   */
  dashboardUrl: string;
}

const TONE_LABEL: Record<DigestBody["overallTone"], string> = {
  celebrate: "It was a strong week",
  neutral: "A mixed week",
  concerning: "Some things to address",
};

const DIRECTION_ARROW: Record<DigestBody["themeMovement"][number]["direction"], string> = {
  up: "↑",
  down: "↓",
  flat: "→",
};

export function renderDigestEmail(input: RenderDigestEmailInput): string {
  const { businessName, periodStart, periodEnd, body, dashboardUrl } = input;
  const url = buildDashboardUrl(dashboardUrl, periodStart, periodEnd);
  const range = `${formatDate(periodStart)} – ${formatDate(addDays(periodEnd, -1))}`;

  const themeRows = body.themeMovement
    .map((m) => {
      const sign = m.delta > 0 ? `+${m.delta}` : `${m.delta}`;
      return `<tr>
        <td style="padding:6px 12px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#111;">${escapeHtml(prettyTheme(m.theme))}</td>
        <td style="padding:6px 12px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#555;text-align:right;">${DIRECTION_ARROW[m.direction]} ${sign}</td>
      </tr>`;
    })
    .join("\n");

  const patternCards = body.topPatterns
    .map((p, i) => {
      const evidence = p.evidence
        .slice(0, 2)
        .map(
          (e) => `
        <blockquote style="margin:8px 0 0;padding:8px 12px;border-left:3px solid #d0d7de;background:#f6f8fa;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#444;line-height:1.4;">
          <span style="display:block;color:#888;font-size:11px;margin-bottom:4px;">${e.starRating}/5 · ${e.themes.map(prettyTheme).map(escapeHtml).join(", ")}</span>
          ${escapeHtml(e.redactedQuote)}
        </blockquote>`,
        )
        .join("");
      return `<div style="margin:24px 0;padding:16px 20px;border:1px solid #e1e4e8;border-radius:8px;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#666;letter-spacing:0.08em;text-transform:uppercase;">Suggested action ${i + 1}</div>
        <h3 style="margin:6px 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:18px;color:#111;">${escapeHtml(p.title)}</h3>
        <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#333;line-height:1.5;">${escapeHtml(p.tailoredBody)}</p>
        ${evidence}
      </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f6f7;">
    <div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#111;">
      <div style="margin-bottom:24px;">
        <div style="font-size:12px;color:#888;letter-spacing:0.08em;text-transform:uppercase;">Weekly Digest</div>
        <h1 style="margin:6px 0 4px;font-size:22px;color:#111;">${escapeHtml(businessName)}</h1>
        <div style="font-size:14px;color:#555;">${escapeHtml(range)} · ${escapeHtml(TONE_LABEL[body.overallTone])}</div>
      </div>
      ${
        body.themeMovement.length > 0
          ? `<h2 style="margin:24px 0 8px;font-size:16px;color:#111;">Theme movement</h2>
            <table style="width:100%;border-collapse:collapse;border:1px solid #e1e4e8;border-radius:6px;overflow:hidden;">
              ${themeRows}
            </table>`
          : ""
      }
      <h2 style="margin:32px 0 8px;font-size:16px;color:#111;">Top 3 suggested actions</h2>
      ${patternCards}
      <div style="margin:32px 0 0;text-align:center;">
        <a href="${escapeAttr(url)}" style="display:inline-block;padding:12px 24px;background:#0969da;color:#ffffff;text-decoration:none;border-radius:6px;font-family:Helvetica,Arial,sans-serif;font-size:14px;">Open dashboard</a>
      </div>
      <p style="margin:32px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#888;line-height:1.5;">
        You received this because you are an Operator at ${escapeHtml(businessName)}. The suggestions
        above are curated remediation and reinforcement Patterns tailored to this week's Reviews.
      </p>
    </div>
  </body>
</html>`;
}

export function buildDashboardUrl(base: string, periodStart: Date, periodEnd: Date): string {
  // `since` is inclusive; `until` is exclusive. Coordinated with slice 12.
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}since=${encodeURIComponent(periodStart.toISOString())}&until=${encodeURIComponent(periodEnd.toISOString())}`;
}

function prettyTheme(theme: string): string {
  return theme.replace(/_/g, " ");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
