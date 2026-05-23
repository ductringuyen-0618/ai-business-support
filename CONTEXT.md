# ai-business-support

A self-serve B2B SaaS that aggregates customer reviews for a Business from multiple external review platforms (Google, Yelp, Facebook, etc.), surfaces themes and incidents, and notifies the Business's Operators.

## Language

### Actors

**Business**:
A customer of our SaaS — typically a single physical or online business that wants its reviews monitored. The unit of data ownership and billing.
_Avoid_: Tenant, Client, Account, Company.

**Operator**:
A human at a Business who logs in to our app, connects review platforms, and receives escalations. One Business has one or more Operators.
_Avoid_: User, Admin, Manager, Owner (too narrow — covers anyone at the Business with access).

**Reviewer**:
An end-customer of the Business who has posted a Review on an external platform. We do not have a relationship with the Reviewer; we only observe their public Reviews.
_Avoid_: User, Customer (ambiguous — could mean Business's customer or our customer), Author.

### Core nouns

**Review**:
A single piece of public feedback (star rating, text, timestamp, author handle) posted by a Reviewer on an external Source about a Business. Immutable from our side — we observe it, we do not store edits in place; new versions from the Source are stored as new Reviews referencing the same Source ID.
_Avoid_: Comment, Feedback, Post.

**Source**:
An external review platform we ingest Reviews from (e.g. Google, Yelp, Facebook). Each Source has its own access mechanism, rate limits, and freshness profile.
_Avoid_: Provider, Channel, Integration.

### Time

**Notification latency**:
Time elapsed from a Review appearing on a Source to the relevant Operator being notified about it (when notification is warranted). Target: 5–15 minutes. See [ADR-0001](./docs/adr/0001-latency-budget-and-ingestion-model.md).
_Avoid_: Real-time, near-real-time (too vague), latency (overloaded).

### Triage

**Incident**:
A Review that an LLM classifier has flagged as warranting Operator attention beyond passive dashboard surfacing. Determined by content, not star rating — a 4-star Review describing a serious problem can be an Incident; a 1-star Review about a long wait may not be. See [ADR-0002](./docs/adr/0002-llm-driven-incident-classification.md).
_Avoid_: Alert (overloaded with monitoring), Flag, Issue (overlaps with GitHub Issues).

**Escalation**:
The act of pushing an Incident to one or more Operators through a Channel. An Incident may produce zero or more Escalations depending on Operator preferences and Channel configuration.
_Avoid_: Notification (too generic), Alert, Page.

**Channel**:
A medium through which Escalations are delivered to an Operator. MVP supports Email (always available) and SMS (opt-in per Operator). Slack, push, etc. deferred. Each Operator has per-Channel preferences including quiet hours.
_Avoid_: Notification method, Transport (too low-level), Delivery method.

**Reply**:
An LLM-drafted response to a Review, included in the Escalation payload for the Operator to copy and post manually on the Source. Always draft-only in MVP — we never auto-post and never request write scopes on any Source. See [ADR-0003](./docs/adr/0003-llm-drafted-replies-no-auto-post.md).
_Avoid_: Response (overloaded with HTTP), Comment, Answer.

**Theme**:
A category of feedback the classifier tags a Review with at ingest. A small fixed top-level taxonomy (`service`, `product_quality`, `cleanliness`, `wait_time`, `pricing`, `staff_attitude`, `accessibility`, `other`) plus optional LLM-generated free-text sub-tags. Themes are queryable via SQL and drive the trend dashboard and weekly Digest. See [ADR-0004](./docs/adr/0004-single-llm-call-at-review-ingest.md).
_Avoid_: Category, Tag (overloaded), Topic.

**Digest**:
A weekly email summary sent to each Operator. Reads already-classified Reviews from the past week, summarises Theme movement (improved/regressed), highlights the top 3 suggested actions, and is the second routine Operator touchpoint after Escalations.
_Avoid_: Report (too generic), Summary, Newsletter.

## Flagged ambiguities

Open questions that must be resolved before they bite — but didn't need to be answered in the first grilling session:

- **PII & Reviewer-data handling.** Reviews contain Reviewer names and identifying detail. Decide before launching with real customer data: do we redact Reviewer names before sending Review text to the LLM? What's our retention policy? Do we support Reviewer deletion requests (GDPR / CCPA)? Likely an ADR before first paying Business.
- **Suggestion shape: open-ended vs. light playbook.** The weekly Digest's top-3 suggested actions can be fully LLM-generated (more impressive, more inconsistent) or LLM-selected from a curated playbook of remediation patterns (more consistent, less impressive). Start open-ended; revisit after first 5 Businesses worth of feedback.
- **Backfill behaviour on signup.** When a Business connects Google, do we ingest the full review history (could be 200+ Reviews, one-time ~$2 LLM cost) or only Reviews from connect-time forward? Likely full backfill — it makes the dashboard useful on day 1 — but confirm.
- **Auth provider.** Clerk vs Auth.js vs Supabase Auth. Decide when building the signup flow.

## Example dialogue

> **Operator (logging in):** "I want to see all the new reviews."
>
> **App:** "Here are the 7 Reviews from the last 24 hours across your 3 Sources. One was flagged as an Incident."
>
> **Operator:** "Show me which Reviewer left the 1-star one."
>
> **App:** "Reviewer 'JaneD' on Google. Posted 12 minutes ago. We've already paged you about it."
