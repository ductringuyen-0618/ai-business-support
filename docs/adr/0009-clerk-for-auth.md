# Auth: Clerk

Authentication, signup, login, password recovery, MFA, organization/invite UX is delegated to Clerk. Clerk's Organizations primitive maps onto our Business; Clerk users map onto our Operators.

## Why

Auth, invites, recovery flows, and multi-org switching are not differentiators for this product, but writing them well is ≥1 week of work that would otherwise be spent on the actual product. Clerk's Organizations primitive is a clean fit for Business + Operator + invites (Operator joins by invite link), its hosted UI components drop into Next.js cleanly, and Google SSO is a one-toggle setup — important because an Operator who's about to OAuth their Google Business Profile is already signed into Google. The free tier covers 10K MAU, comfortably the first year.

## Considered options

- **Auth.js (NextAuth v5)** — free, open-source, runs in our own DB, but we'd implement invites, orgs, recovery, MFA, audit log ourselves. Right answer if optimising for $0 long-term cost; wrong for solo-dev MVP velocity.
- **Supabase Auth** — awkward fit since we picked Neon ([ADR-0005](./0005-stack-nextjs-neon-vercel.md)). Adopting it means dual Postgres or switching off Neon.
- **WorkOS** — built for enterprise SAML/SCIM. Overkill at $125/mo for SMB customers. The right addition *on top of* Clerk if we ever sell to enterprise.

## Consequences

- Clerk webhooks (`user.created`, `organization.created`, `organizationMembership.created`, `user.deleted`) seed and maintain our local `Business` and `Operator` rows. Local rows mirror the Clerk identity; Clerk is the source of truth for auth.
- The Operator's Clerk user ID is the foreign key on the `Operator` row; the Business's Clerk org ID is the foreign key on the `Business` row. Avoid storing email/password locally.
- Migration off Clerk later (if pricing or feature direction sours) requires: implement Auth.js, write a one-time "reset on next login" migration since password hashes are in Clerk. Real work but tractable; the rest of the app is provider-agnostic.
- The app must enforce its own multi-tenant data isolation in queries (`WHERE business_id = current_operator.business_id`) — Clerk only handles identity, not row-level authorisation.
- Pricing transition at >10K MAU: ~$25/mo base + $0.02/MAU above 10K. Budget for it once activated Businesses exceed ~1,000 (assuming ~10 Operators per Business average).
- Google "sign in to the app" (Clerk-handled) is a separate OAuth flow from "connect your Business Profile" (we handle, with `business.manage` read-only scope per [ADR-0003](./0003-llm-drafted-replies-no-auto-post.md)). Two consent screens — that's fine; they're for different things.
