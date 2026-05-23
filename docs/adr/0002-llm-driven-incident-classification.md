# LLM classifier (not star-rating rules) defines an Incident

An Incident is determined by an LLM reading the Review text — not by a star-rating threshold. MVP runs the classifier on every new Review.

## Why

A star-rating rule (e.g. ≤2 stars) is what every commodity competitor does. It misses the cases that matter most: a 4-star Review mentioning a slur, an allergic reaction, food-safety language, or a manager's name in an accusation. Those are the moments an Operator most wants to be paged about, and they are exactly the ones a star threshold cannot catch. The 5–15-minute latency budget from [ADR-0001](./0001-latency-budget-and-ingestion-model.md) was chosen specifically to make this feasible — there is room for an LLM call in the hot path.

## Consequences

- The "intelligent triage" framing is a real differentiator, not a marketing claim.
- Each new Review costs a few cents in LLM tokens. Cost scales with ingestion volume; budget accordingly.
- The classifier's prompt and output schema become a load-bearing piece of code — versioned, tested with evals (see [evaluate-skill](../../.claude/skills/evaluate-skill/SKILL.md) approach).
- Burst-window detection ("3 negative Reviews in 1 hour") and explicit keyword escalation (e.g. "ambulance", "lawsuit") are deferred to phase 2 and phase 3 respectively, gated on real customer data and explicit asks.
- If a customer later demands sub-minute latency that no longer fits an LLM call, we split into a rule-based fast-path + LLM slow-path. Refactor, not rewrite.
