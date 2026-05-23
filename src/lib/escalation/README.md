# EscalationRouter

Pure-function module that maps an Incident + the Business's Operators + their
per-Channel preferences + the current time to a list of `Delivery` plans.

```ts
import { route } from "@/lib/escalation";

const deliveries = route({
  incident,
  operators, // { id: string }[]
  prefs, // OperatorChannelPref[]
  now, // Date
});
```

Terminology follows [`CONTEXT.md`](../../../CONTEXT.md) verbatim — Channel,
Operator, Incident, Escalation.

## Contract

- **Pure.** No I/O, no globals, no `Date.now()`. The `now` argument is the only
  time source. Calling twice with the same input returns equal output.
- **Broadcast.** Every enabled `(Operator, Channel)` pair yields exactly one
  Delivery. Nothing is silently dropped.
- **Quiet hours defer, never drop.** If `now` is inside an Operator's quiet
  hours for a given Channel, `deliver_at` is set to the next end-of-quiet-hours
  in that Operator's timezone (converted to UTC). Otherwise `deliver_at = now`.
- **Disabled pairs are skipped.** `enabled = false` yields no Delivery for the
  pair (SMS is opt-in per Operator; Email defaults to enabled).
- **Unknown operators are skipped.** Pref rows referencing operators not in the
  `operators` input are ignored. The caller controls the Operator set.
- **Persistence is the caller's problem.** Slice 11's `fire_incident` job is
  responsible for idempotent persistence of the returned Deliveries.

## Broadcast policy

Locked in PRD session 1 (Q7) and reaffirmed in [ADR-0009](../../../docs/adr/0009-clerk-for-auth.md):

- **Email** is always available.
- **SMS** is opt-in per Operator (`enabled = true` on the SMS row).
- Quiet hours are per `(Operator, Channel)` pair — an Operator can have
  different quiet hours on Email vs SMS.

When an Incident fires, the router emits one Delivery per enabled pair across
every Operator at the Business. Quiet-hours-active Deliveries are deferred to
the end of the window; they are never collapsed into a single channel, and
they are never dropped.

## Quiet-hours semantics

- Stored as Postgres `time` (no zone) in `operator_channel_prefs`. Combined
  with the row's `timezone` (IANA, default `UTC`) at compute time.
- `start === end` (or either bound null) means "no quiet hours" — no minute
  is inside the window.
- The window is `[start, end)` — inclusive of start, exclusive of end. An
  Operator whose quiet hours end at 09:00 is reachable AT 09:00.
- Windows may cross midnight, e.g. `23:00 → 07:00`. In that case "inside"
  means `now >= start` (evening tail) OR `now < end` (morning head); the
  end-of-window date is tomorrow if we're in the evening tail.
- DST transitions are delegated to [`date-fns-tz`](https://github.com/marnusw/date-fns-tz).
  On a spring-forward day, an end-of-window that lands in the missing slot
  (e.g. 02:30 in `America/New_York` on 2024-03-10) is resolved by
  `fromZonedTime` by interpreting the wall-clock in the post-transition zone
  (i.e. 02:30 is treated as 02:30 EDT, yielding 06:30 UTC). The unit test
  `DST spring-forward` pins this so a regression in the upstream library is
  caught.

## Files

- `index.ts` — the module. `route()` + types.
- `index.test.ts` — table-driven tests covering every acceptance criterion of
  [issue #7](https://github.com/ductringuyen-0618/ai-business-support/issues/7).
- Schema: `operator_channel_prefs` in [`src/db/schema.ts`](../../db/schema.ts).
  Migration: `drizzle/0001_operator_channel_prefs.sql`.

## Related

- [ADR-0009: Clerk for auth](../../../docs/adr/0009-clerk-for-auth.md) — Channel
  posture and Operator identity.
- [PRD #1](https://github.com/ductringuyen-0618/ai-business-support/issues/1) —
  session 1 Q7 locks the broadcast routing model.
