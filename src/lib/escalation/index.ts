/**
 * EscalationRouter — given an Incident, a Business's Operators, their per-Channel
 * preferences, and the current time, returns the list of Delivery plans (one per
 * enabled Operator × Channel pair) with a `deliver_at` timestamp.
 *
 * Pure function. No I/O. No globals. No `Date.now()`. The `now` argument is the
 * sole time source so the function is fully testable and the slice-11
 * `fire_incident` job can persist Deliveries idempotently.
 *
 * Domain terminology follows `CONTEXT.md` verbatim — Channel, Operator, Incident,
 * Escalation. Broadcast policy and Channel posture are locked by ADR-0009 and
 * PRD session 1 Q7:
 *
 * - Email is always-on; SMS is opt-in per Operator (the `enabled` flag).
 * - Every enabled (Operator, Channel) pair yields exactly one Delivery.
 * - Quiet-hours-active deliveries are deferred to the end of quiet hours in the
 *   Operator's local timezone, NOT dropped.
 *
 * See `src/lib/escalation/README.md` for the contract.
 */
import { fromZonedTime, toZonedTime } from "date-fns-tz";

export type Channel = "email" | "sms";

export interface Incident {
  id: string;
  severity: "low" | "medium" | "high";
  // The router does not consume other fields; callers may pass extras.
}

export interface OperatorChannelPref {
  operator_id: string;
  channel: Channel;
  enabled: boolean;
  /** Local-time "HH:mm" (or "HH:mm:ss"). Null disables quiet hours for this pair. */
  quiet_hours_start: string | null;
  /** Local-time "HH:mm" (or "HH:mm:ss"). Null disables quiet hours for this pair. */
  quiet_hours_end: string | null;
  /** IANA zone name, e.g. "America/New_York". */
  timezone: string;
}

export interface Delivery {
  operator_id: string;
  channel: Channel;
  deliver_at: Date;
}

interface RouteInput {
  incident: Incident;
  operators: { id: string }[];
  prefs: OperatorChannelPref[];
  now: Date;
}

/**
 * Returns one Delivery per enabled (Operator, Channel) pair belonging to one of
 * the supplied Operators. Disabled pairs are omitted. Quiet-hours-active pairs
 * are deferred to the next end-of-quiet-hours in the Operator's timezone.
 *
 * Operators with no matching pref rows produce no Deliveries — the caller is
 * responsible for seeding default prefs (handled by the Clerk webhook flow in
 * slice 2 and the prefs UI in slice 11).
 */
export function route(input: RouteInput): Delivery[] {
  const { operators, prefs, now } = input;
  const operatorIds = new Set(operators.map((o) => o.id));
  const deliveries: Delivery[] = [];

  for (const pref of prefs) {
    if (!operatorIds.has(pref.operator_id)) continue;
    if (!pref.enabled) continue;

    const deliverAt = computeDeliverAt(pref, now);
    deliveries.push({
      operator_id: pref.operator_id,
      channel: pref.channel,
      deliver_at: deliverAt,
    });
  }

  return deliveries;
}

/**
 * Resolves `deliver_at` for a single pref row:
 * - No quiet hours configured (either bound null, or start === end) → `now`.
 * - `now` outside the quiet window → `now`.
 * - `now` inside the quiet window → the next end-of-window in the operator's
 *   timezone, converted back to UTC. Handles windows that cross midnight
 *   (e.g. 23:00 → 07:00).
 */
function computeDeliverAt(pref: OperatorChannelPref, now: Date): Date {
  const { quiet_hours_start, quiet_hours_end, timezone } = pref;
  if (!quiet_hours_start || !quiet_hours_end) return now;

  const start = parseHm(quiet_hours_start);
  const end = parseHm(quiet_hours_end);
  // A zero-length window is treated as "no quiet hours" — no minute is inside it.
  if (start.h === end.h && start.m === end.m) return now;

  // Convert `now` into the operator's local wall-clock. `toZonedTime` returns
  // a Date whose UTC fields read as the wall-clock components in the target
  // zone — i.e. it shifts the instant; we only read the fields, never use it
  // as an instant.
  const nowLocal = toZonedTime(now, timezone);
  const yyyy = nowLocal.getFullYear();
  const mm = nowLocal.getMonth();
  const dd = nowLocal.getDate();
  const nowMinutes = nowLocal.getHours() * 60 + nowLocal.getMinutes();
  const startMinutes = start.h * 60 + start.m;
  const endMinutes = end.h * 60 + end.m;

  const crossesMidnight = startMinutes > endMinutes;

  let inside: boolean;
  let endDateLocal: { y: number; mo: number; d: number };

  if (!crossesMidnight) {
    // Same-day window [start, end). Inclusive of start, exclusive of end —
    // an Operator whose quiet hours end at 09:00 is reachable AT 09:00.
    inside = nowMinutes >= startMinutes && nowMinutes < endMinutes;
    endDateLocal = { y: yyyy, mo: mm, d: dd };
  } else {
    // Midnight-crossing window, e.g. 23:00 → 07:00. Inside if we're in the
    // evening tail [start, 24:00) OR the morning head [00:00, end).
    const eveningTail = nowMinutes >= startMinutes;
    const morningHead = nowMinutes < endMinutes;
    inside = eveningTail || morningHead;
    // End-of-window lands on tomorrow's date if we're in the evening tail,
    // today's date if we're in the morning head.
    if (eveningTail) {
      const tomorrow = addDays({ y: yyyy, mo: mm, d: dd }, 1);
      endDateLocal = tomorrow;
    } else {
      endDateLocal = { y: yyyy, mo: mm, d: dd };
    }
  }

  if (!inside) return now;

  // Build a "wall-clock" Date at end-of-window in the operator's local zone,
  // then convert to UTC. `fromZonedTime` resolves DST gaps deterministically
  // (spring-forward: a missing local time is interpreted in the
  // post-transition zone — see `index.test.ts` "DST spring-forward").
  const wallClock = buildLocalDate(endDateLocal, end);
  return fromZonedTime(wallClock, timezone);
}

interface HourMinute {
  h: number;
  m: number;
}

/** Parses "HH:mm" or "HH:mm:ss" into hour+minute components. */
function parseHm(value: string): HourMinute {
  const parts = value.split(":");
  if (parts.length < 2) {
    throw new Error(`Invalid time string: ${value}`);
  }
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Invalid time string: ${value}`);
  }
  return { h, m };
}

/**
 * Returns a Date whose UTC fields encode the wall-clock components in the
 * operator's local zone. This is the inverse shape expected by
 * `fromZonedTime` — we construct a Date in UTC with the local fields, then
 * `fromZonedTime` reinterprets those fields as local time in the IANA zone.
 */
function buildLocalDate(date: { y: number; mo: number; d: number }, hm: HourMinute): Date {
  return new Date(Date.UTC(date.y, date.mo, date.d, hm.h, hm.m, 0, 0));
}

function addDays(
  date: { y: number; mo: number; d: number },
  days: number,
): {
  y: number;
  mo: number;
  d: number;
} {
  // Use a UTC anchor to avoid host-timezone DST surprises during arithmetic;
  // we only care about the calendar fields, not the instant.
  const anchor = new Date(Date.UTC(date.y, date.mo, date.d));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return {
    y: anchor.getUTCFullYear(),
    mo: anchor.getUTCMonth(),
    d: anchor.getUTCDate(),
  };
}
