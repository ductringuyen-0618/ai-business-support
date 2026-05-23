# Latency budget: 5–15 minutes from Source publication to Operator notification

We target 5–15 minutes (not seconds) from a Review appearing on an external Source to the Operator being notified about an Incident. This is faster than digest tools but slower than real-time paging.

## Why

The Reviewer has already posted and left; the Operator cannot prevent the Review. The realistic value is *"Operator can reach out before the next service interaction"* — that's hours, not seconds. A 5–15 min budget avoids alert fatigue, keeps Pub/Sub from being mandatory on day 1 (polling at 5-min intervals is a valid fallback), and crucially **leaves headroom for an LLM in the hot path of incident classification** (a few seconds is fine inside a 5-minute budget). Sub-minute would force a rule-based classifier first and an LLM slow-path, which is materially more code.

## Consequences

- Push (Google Pub/Sub) is preferred where available, but polling-every-5-min is an acceptable fallback for any Source without push semantics.
- The Incident classifier may be a single synchronous LLM call (no fast-path/slow-path split needed in MVP).
- Escalation channels need only be "reasonably fast", not push-instant: SMS, email, Slack message, dashboard banner all qualify. Native push notifications are not required for MVP.
- If a customer later demands sub-minute, the work is a refactor (split classifier into rule fast-path + LLM slow-path; mandate Pub/Sub) — not a rewrite.
