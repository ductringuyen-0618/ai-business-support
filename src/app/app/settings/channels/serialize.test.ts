/**
 * Unit tests for the channels settings form serializer (slice 11).
 *
 * Exercises the pure transformation in isolation from React — the production
 * client component drives `serializeChannelPrefsForm` then POSTs to the
 * `/api/operator/channel-prefs` route, so the contract pinned here is what
 * the API receives.
 */
import { describe, expect, it } from "vitest";

import { serializeChannelPrefsForm, type ChannelPrefsFormState } from "./serialize";

function baseState(): ChannelPrefsFormState {
  return {
    email: {
      enabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      timezone: "America/Los_Angeles",
    },
    sms: {
      enabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: "UTC",
      phoneE164: "+15555550123",
    },
  };
}

describe("serializeChannelPrefsForm", () => {
  it("drops phoneE164 from the SMS block — the verify route owns that column", () => {
    const out = serializeChannelPrefsForm(baseState());
    expect(out.sms).not.toHaveProperty("phoneE164");
    expect(out.email).not.toHaveProperty("phoneE164");
  });

  it("preserves the boolean enabled flags", () => {
    const state = baseState();
    state.email.enabled = false;
    state.sms.enabled = true;
    const out = serializeChannelPrefsForm(state);
    expect(out.email.enabled).toBe(false);
    expect(out.sms.enabled).toBe(true);
  });

  it("normalises empty-string time inputs to null", () => {
    const state = baseState();
    state.email.quietHoursStart = "";
    state.email.quietHoursEnd = "   ";
    const out = serializeChannelPrefsForm(state);
    expect(out.email.quietHoursStart).toBeNull();
    expect(out.email.quietHoursEnd).toBeNull();
  });

  it("preserves valid HH:mm strings", () => {
    const out = serializeChannelPrefsForm(baseState());
    expect(out.email.quietHoursStart).toBe("22:00");
    expect(out.email.quietHoursEnd).toBe("07:00");
  });

  it("preserves the timezone string verbatim", () => {
    const out = serializeChannelPrefsForm(baseState());
    expect(out.email.timezone).toBe("America/Los_Angeles");
    expect(out.sms.timezone).toBe("UTC");
  });
});
