# Redact Reviewer identifiers before LLM; store full data; manual deletion workflow

When a Review is ingested, the Reviewer display name and any free-text personal-name matches are replaced with a `[REVIEWER]` token before the Review text is sent to Anthropic. The original Review (including Reviewer name, encrypted at rest by Neon by default) is stored in our Postgres. Deletion Requests from Reviewers are handled manually via a support email: the Reviewer's name is nulled out and the original review text is nulled, but the row is retained so that aggregate themes/severity/timestamp continue to support trend reporting.

## Why

Anthropic is the only third-party data processor in our data path; minimising what they see is the highest-leverage privacy move. The classifier does not need Reviewer names to detect themes or Incidents, so redaction is free of classification value. Storing the full Review in our own DB preserves dashboard affordances ("show this Reviewer's history", "draft a reply addressed to JaneD") that a hash-everything posture would destroy. A manual deletion workflow is right-sized for an MVP — at single-digit Businesses, a Linear ticket and a SQL script is faster to ship than a self-service portal and ages into one when volume justifies it.

A "mirror public Google data as-is" stance is technically defensible but ages badly: the first time a Reviewer screenshots a refusal-to-delete reply and posts it, the reputational damage lands on us, not Google. A full strict posture (hashed names, per-Business KMS, region-aware LLM routing) is correct for EU enterprise but is months of engineering an MVP customer doesn't need yet.

## Consequences

- The Review ingestion pipeline gains a redaction step before the LLM call. Implementation: replace the known Reviewer display name token, plus a basic NER pass for first-name-like tokens. Wrong-direction misses (a name we fail to redact) are tolerable; over-redaction is also tolerable (replacing "Maria" the manager's name doesn't hurt classification).
- The Review row schema needs nullable `reviewer_display_name` and `review_text` columns so a Deletion Request can null them without dropping the row.
- A Deletion Request is a process noun in our domain — surface it in CONTEXT.md and document the runbook in `docs/runbooks/deletion-request.md` when one is first received.
- Retention: Reviews are kept indefinitely while the Business is active. On Business cancellation, all Reviews are purged after a 30-day grace period.
- Profile photo URLs from Google are not stored — they reference an external Google URL that may itself rotate, and they add no classifier value.
- This posture is upgradable: moving to hashed names, region-aware routing, or self-service deletion is a refactor (one column rewrite + endpoint), not a rewrite.
- This posture is **not** GDPR-certified or HIPAA-compliant. Customers requiring either get a polite "not yet" and become a roadmap signal for a Compliance ADR.
