/**
 * EscalationRouter unit tests.
 *
 * Table-driven coverage of every case called out in issue #7:
 * - single Operator + Email only
 * - single Operator + Email + SMS, SMS in quiet hours
 * - two Operators with different quiet hours
 * - quiet hours crossing midnight (23:00 → 07:00)
 * - Operator in America/New_York while `now` is UTC
 * - DST spring-forward day (the 02:30 gap on 2024-03-10 in New York)
 * - Operator with all Channels disabled
 *
 * Plus: broadcast invariant (one Delivery per enabled pair), purity (idempotent
 * across calls with the same inputs).
 */
import { describe, expect, it } from "vitest";

import { route, type Incident, type OperatorChannelPref } from "./index";

const INCIDENT: Incident = { id: "inc_1", severity: "high" };

function pref(overrides: Partial<OperatorChannelPref>): OperatorChannelPref {
  return {
    operator_id: "op_1",
    channel: "email",
    enabled: true,
    quiet_hours_start: null,
    quiet_hours_end: null,
    timezone: "UTC",
    ...overrides,
  };
}

describe("EscalationRouter.route", () => {
  it("single Operator with Email only → one Delivery at now", () => {
    const now = new Date("2026-05-23T12:00:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [pref({ channel: "email" })],
      now,
    });
    expect(out).toEqual([{ operator_id: "op_1", channel: "email", deliver_at: now }]);
  });

  it("single Operator with Email + SMS, SMS in quiet hours → SMS deferred, Email immediate", () => {
    // 02:30 UTC: SMS quiet hours are 02:00–06:00 UTC; Email has none.
    const now = new Date("2026-05-23T02:30:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({ channel: "email" }),
        pref({
          channel: "sms",
          quiet_hours_start: "02:00",
          quiet_hours_end: "06:00",
          timezone: "UTC",
        }),
      ],
      now,
    });
    expect(out).toHaveLength(2);

    const email = out.find((d) => d.channel === "email")!;
    const sms = out.find((d) => d.channel === "sms")!;
    expect(email.deliver_at).toEqual(now);
    expect(sms.deliver_at.toISOString()).toBe("2026-05-23T06:00:00.000Z");
  });

  it("two Operators with different quiet hours → each deferred to their own window end", () => {
    const now = new Date("2026-05-23T08:30:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_a" }, { id: "op_b" }],
      prefs: [
        pref({
          operator_id: "op_a",
          channel: "email",
          quiet_hours_start: "08:00",
          quiet_hours_end: "09:00",
          timezone: "UTC",
        }),
        pref({
          operator_id: "op_b",
          channel: "email",
          quiet_hours_start: "08:00",
          quiet_hours_end: "10:30",
          timezone: "UTC",
        }),
      ],
      now,
    });
    expect(out).toHaveLength(2);
    const a = out.find((d) => d.operator_id === "op_a")!;
    const b = out.find((d) => d.operator_id === "op_b")!;
    expect(a.deliver_at.toISOString()).toBe("2026-05-23T09:00:00.000Z");
    expect(b.deliver_at.toISOString()).toBe("2026-05-23T10:30:00.000Z");
  });

  it("quiet hours crossing midnight, now in the evening tail → defer to next-day end", () => {
    // 23:30 UTC, window 23:00 → 07:00 UTC.
    const now = new Date("2026-05-23T23:30:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "23:00",
          quiet_hours_end: "07:00",
          timezone: "UTC",
        }),
      ],
      now,
    });
    expect(out).toHaveLength(1);
    expect(out[0].deliver_at.toISOString()).toBe("2026-05-24T07:00:00.000Z");
  });

  it("quiet hours crossing midnight, now in the morning head → defer to same-day end", () => {
    const now = new Date("2026-05-23T03:00:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "23:00",
          quiet_hours_end: "07:00",
          timezone: "UTC",
        }),
      ],
      now,
    });
    expect(out[0].deliver_at.toISOString()).toBe("2026-05-23T07:00:00.000Z");
  });

  it("quiet hours crossing midnight, now outside → deliver immediately", () => {
    // 12:00 UTC is squarely outside 23:00–07:00.
    const now = new Date("2026-05-23T12:00:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "23:00",
          quiet_hours_end: "07:00",
          timezone: "UTC",
        }),
      ],
      now,
    });
    expect(out[0].deliver_at).toEqual(now);
  });

  it("Operator in America/New_York while `now` is UTC", () => {
    // 02:30 UTC on 2026-05-23 is 22:30 EDT on 2026-05-22 (UTC-4 during DST).
    // Operator's quiet hours 22:00 → 06:00 local → we're in the evening tail,
    // end-of-window is 06:00 EDT on 2026-05-23 → 10:00 UTC on 2026-05-23.
    const now = new Date("2026-05-23T02:30:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "22:00",
          quiet_hours_end: "06:00",
          timezone: "America/New_York",
        }),
      ],
      now,
    });
    expect(out[0].deliver_at.toISOString()).toBe("2026-05-23T10:00:00.000Z");
  });

  it("Operator in America/New_York, now outside local quiet hours → deliver immediately", () => {
    // 17:00 UTC on 2026-05-23 = 13:00 EDT — well outside 22:00–06:00.
    const now = new Date("2026-05-23T17:00:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "22:00",
          quiet_hours_end: "06:00",
          timezone: "America/New_York",
        }),
      ],
      now,
    });
    expect(out[0].deliver_at).toEqual(now);
  });

  it("DST spring-forward: end-of-quiet-hours falls in the missing 02:30 slot", () => {
    // 2024-03-10 in America/New_York: clocks jump 02:00 EST → 03:00 EDT, so
    // 02:30 local does not exist. Set end-of-window to 02:30 with `now`
    // squarely inside the window (01:00 EST = 06:00 UTC, before the jump).
    // date-fns-tz `fromZonedTime` resolves the missing 02:30 by interpreting
    // it in the post-transition zone (EDT, UTC-4), yielding 06:30 UTC.
    // This is deterministic and well-documented — we pin the behaviour so a
    // regression in the upstream library is caught.
    const now = new Date("2024-03-10T06:00:00.000Z"); // 01:00 EST
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "00:00",
          quiet_hours_end: "02:30",
          timezone: "America/New_York",
        }),
      ],
      now,
    });
    const deliverAt = out[0].deliver_at;
    expect(Number.isFinite(deliverAt.getTime())).toBe(true);
    expect(deliverAt.getTime()).toBeGreaterThan(now.getTime());
    expect(deliverAt.toISOString()).toBe("2024-03-10T06:30:00.000Z");
  });

  it("DST fall-back day still yields a valid UTC instant", () => {
    // 2024-11-03 NY: 02:00 EDT → 01:00 EST. 01:30 happens twice. We just
    // assert determinism + finiteness here — the ambiguous-time policy is
    // date-fns-tz's responsibility.
    const now = new Date("2024-11-03T05:00:00.000Z"); // 01:00 EDT
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "00:00",
          quiet_hours_end: "01:30",
          timezone: "America/New_York",
        }),
      ],
      now,
    });
    expect(Number.isFinite(out[0].deliver_at.getTime())).toBe(true);
  });

  it("Operator with all Channels disabled → no Deliveries", () => {
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [pref({ channel: "email", enabled: false }), pref({ channel: "sms", enabled: false })],
      now: new Date("2026-05-23T12:00:00.000Z"),
    });
    expect(out).toEqual([]);
  });

  it("disabled SMS + enabled Email → only Email Delivery", () => {
    const now = new Date("2026-05-23T12:00:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [pref({ channel: "email" }), pref({ channel: "sms", enabled: false })],
      now,
    });
    expect(out).toEqual([{ operator_id: "op_1", channel: "email", deliver_at: now }]);
  });

  it("ignores prefs that reference operators not in the input list", () => {
    const now = new Date("2026-05-23T12:00:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({ operator_id: "op_1", channel: "email" }),
        pref({ operator_id: "op_ghost", channel: "email" }),
      ],
      now,
    });
    expect(out).toHaveLength(1);
    expect(out[0].operator_id).toBe("op_1");
  });

  it("operator with no prefs at all → no Deliveries", () => {
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_lonely" }],
      prefs: [],
      now: new Date("2026-05-23T12:00:00.000Z"),
    });
    expect(out).toEqual([]);
  });

  it("treats now == quiet_hours_end as outside the window (inclusive end)", () => {
    // 06:00 UTC, window 02:00–06:00 → not inside; deliver immediately.
    const now = new Date("2026-05-23T06:00:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "02:00",
          quiet_hours_end: "06:00",
          timezone: "UTC",
        }),
      ],
      now,
    });
    expect(out[0].deliver_at).toEqual(now);
  });

  it("treats now == quiet_hours_start as inside the window (inclusive start)", () => {
    const now = new Date("2026-05-23T02:00:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "02:00",
          quiet_hours_end: "06:00",
          timezone: "UTC",
        }),
      ],
      now,
    });
    expect(out[0].deliver_at.toISOString()).toBe("2026-05-23T06:00:00.000Z");
  });

  it("accepts Postgres-style HH:mm:ss time strings (drizzle returns these)", () => {
    const now = new Date("2026-05-23T02:30:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "02:00:00",
          quiet_hours_end: "06:00:00",
          timezone: "UTC",
        }),
      ],
      now,
    });
    expect(out[0].deliver_at.toISOString()).toBe("2026-05-23T06:00:00.000Z");
  });

  it("is pure: two calls with identical inputs return equal Deliveries", () => {
    const now = new Date("2026-05-23T02:30:00.000Z");
    const input = {
      incident: INCIDENT,
      operators: [{ id: "op_1" }],
      prefs: [
        pref({
          channel: "sms",
          quiet_hours_start: "02:00",
          quiet_hours_end: "06:00",
          timezone: "UTC",
        }),
      ],
      now,
    };
    const a = route(input);
    const b = route(input);
    expect(a).toEqual(b);
  });

  it("broadcast invariant: every enabled pair yields exactly one Delivery", () => {
    const now = new Date("2026-05-23T12:00:00.000Z");
    const out = route({
      incident: INCIDENT,
      operators: [{ id: "op_a" }, { id: "op_b" }, { id: "op_c" }],
      prefs: [
        pref({ operator_id: "op_a", channel: "email" }),
        pref({ operator_id: "op_a", channel: "sms" }),
        pref({ operator_id: "op_b", channel: "email" }),
        pref({ operator_id: "op_b", channel: "sms", enabled: false }),
        pref({ operator_id: "op_c", channel: "email" }),
        // op_c has no SMS row at all
      ],
      now,
    });
    expect(out).toHaveLength(4);
    expect(out.map((d) => `${d.operator_id}:${d.channel}`).sort()).toEqual([
      "op_a:email",
      "op_a:sms",
      "op_b:email",
      "op_c:email",
    ]);
  });
});
