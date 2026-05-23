/**
 * Form-state shape + serializer for the channels settings UI (slice 11).
 *
 * Extracted so the unit tests can exercise the serialisation without rendering
 * the React tree. The shape mirrors the request body accepted by
 * `POST /api/operator/channel-prefs`.
 */

export interface ChannelBlockState {
  enabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
}

export interface ChannelPrefsFormState {
  email: ChannelBlockState;
  sms: ChannelBlockState & { phoneE164: string | null };
}

export interface ChannelPrefsRequestBody {
  email: ChannelBlockState;
  sms: ChannelBlockState;
}

/**
 * Drop `phoneE164` from the SMS block — it's owned by the verify route, not
 * the prefs PATCH. Also normalise empty-string time inputs to `null` (the
 * HTML `<input type="time">` returns "" when cleared, but the API expects
 * null to mean "no quiet hours").
 */
export function serializeChannelPrefsForm(state: ChannelPrefsFormState): ChannelPrefsRequestBody {
  return {
    email: normaliseBlock(state.email),
    sms: normaliseBlock({
      enabled: state.sms.enabled,
      quietHoursStart: state.sms.quietHoursStart,
      quietHoursEnd: state.sms.quietHoursEnd,
      timezone: state.sms.timezone,
    }),
  };
}

function normaliseBlock(block: ChannelBlockState): ChannelBlockState {
  return {
    enabled: block.enabled,
    quietHoursStart: emptyToNull(block.quietHoursStart),
    quietHoursEnd: emptyToNull(block.quietHoursEnd),
    timezone: block.timezone,
  };
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  if (value.trim().length === 0) return null;
  return value;
}
