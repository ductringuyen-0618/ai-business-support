/**
 * In-process Twilio mock for E2E tests. Records the SMS payload via the
 * shared recorder so a spec can assert that an SMS was attempted with the
 * right shape, without touching the Twilio network.
 *
 * NOTE: The happy-path spec doesn't exercise SMS (the seeded Operator has no
 * verified phone, so the Escalation router never routes through this Channel).
 * This mock exists for symmetry with `anthropic-mock` / `resend-mock` and so
 * future specs that DO exercise SMS can opt-in by enabling the SMS pref on
 * the seed Operator.
 */
import type { TwilioSmsClient } from "@/lib/sms/twilio";

import { recordMockCall } from "./recorder";

export function createE2ETwilioMock(): TwilioSmsClient {
  return {
    async send(params: { from: string; to: string; body: string }): Promise<void> {
      recordMockCall({
        service: "twilio",
        payload: {
          from: params.from,
          to: params.to,
          body: params.body,
        },
      });
    },
  };
}
