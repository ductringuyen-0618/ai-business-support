/**
 * In-process Resend mock for E2E tests. Records the email payload via the
 * shared recorder so the spec can assert on subject / recipients without
 * touching the Resend network.
 */
import type { ResendEmailClient } from "@/lib/email/resend";

import { recordMockCall } from "./recorder";

export function createE2EResendMock(): ResendEmailClient {
  return {
    async send(params: {
      from: string;
      to: string[];
      subject: string;
      html: string;
    }): Promise<void> {
      recordMockCall({
        service: "resend",
        payload: {
          from: params.from,
          to: params.to,
          subject: params.subject,
          // Truncate HTML — full body is too noisy for assertions and Playwright
          // traces, but the first 200 chars cover any headline / preheader.
          html_prefix: params.html.slice(0, 200),
        },
      });
    },
  };
}
