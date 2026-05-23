# LLM-drafted Replies are copy-pasted by the Operator; no auto-post

When an Incident fires, the Escalation payload includes an LLM-drafted Reply text. The Operator copies it to the Source themselves. We do not request write scopes on any Source's OAuth, and we do not auto-post under any circumstances.

## Why

A single LLM-generated Reply posted in the Business's name on a real Reviewer's public profile, that turns out to be wrong (e.g. apologising to "Maria" for behaviour the Reviewer alleged but never confirmed; using the Reviewer's name as if confirmed; a hallucinated discount code), is a viral-screenshot disaster that destroys customer trust in us — not just in the LLM. The 5-second copy-paste step is the cheapest possible brake against that class of failure and keeps the Operator unambiguously in the loop. Requesting only read scopes also reduces the Google Business Profile API review surface for early access.

## Consequences

- Source OAuth requests are read-only in MVP (e.g. Google `business.manage` read-only scope, no Reply write permissions).
- The Reply is part of the Incident payload, not a separate post-response action. Data model treats Reply as draft-only state.
- Operators stay in their existing workflow (Google profile / Yelp dashboard) for the actual posting. We are an upstream assistant, not a replacement.
- The "click Send to post from inside our app" feature (`C` in the design tree) is a natural fast-follow once ~10 Businesses are using copy-paste regularly and asking for one-click. It's a new OAuth scope request and a new flow, not a refactor of the read pipeline.
- The "auto-respond" posture (`D`) is rejected, not deferred. Re-opening it requires a new ADR.
