# A single LLM call at Review ingest produces all per-Review classification

When a new Review is ingested, exactly one LLM call is made. It returns a structured payload — `is_incident`, `severity`, `themes`, `sentiment`, `suggested_reply` — which is persisted on the Review row. No second LLM pass is made per Review; the weekly digest reads from already-classified rows.

## Why

We were already going to run an LLM per Review for Incident classification ([ADR-0002](./0002-llm-driven-incident-classification.md)). Extending that single prompt's output schema to also include themes, sentiment, and a draft Reply is essentially free relative to making the call at all, and it makes every downstream capability cheaper: the dashboard can chart and filter by theme using plain SQL, the weekly digest reads pre-classified rows instead of re-processing the entire week, and historical theme queries ("did wait-time complaints drop after we hired the new manager?") become trivial. A per-Review-at-ingest design compounds; a batch-only design leaves themes ephemeral and forces re-processing whenever the question changes.

## Consequences

- The classifier prompt is the single most load-bearing piece of code in the system. It needs versioning, eval coverage (use the [evaluate-skill](../../.claude/skills/evaluate-skill/SKILL.md) methodology), and careful schema evolution — adding a field is fine, repurposing one breaks historical data.
- Theme taxonomy must be designed: a hybrid of a small fixed top-level set (e.g. `service`, `product_quality`, `cleanliness`, `wait_time`, `pricing`, `staff_attitude`, `accessibility`, `other`) plus LLM-generated free-text sub-tags strikes the right balance between query-ability and drift resistance.
- Backfilling historical Reviews at Business signup means running the classifier ~once per imported Review. At ~1¢/call and typical SMB volume (low hundreds), that's a one-time cost of a few dollars per Business.
- LLM cost scales with ingestion volume, not with Operator activity. Heavy-volume Businesses (chains with many locations) need a metered pricing tier eventually.
- If the schema needs a breaking change later, plan a re-classification job over historical Reviews. Keep the raw Review text immutably; the classification is reproducible.
