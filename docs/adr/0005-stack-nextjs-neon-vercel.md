# MVP stack: Next.js + Postgres (Neon) + Vercel + Anthropic SDK + Twilio + Resend

Single Next.js (TypeScript) codebase covering marketing site, Operator dashboard, API routes (Pub/Sub webhook receiver, app endpoints). Postgres on Neon. Background jobs via pg-boss inside Postgres. LLM via the Anthropic Node SDK. SMS via Twilio. Email via Resend. Deploy on Vercel.

## Why

This is a solo-dev MVP with a 5–15 min latency budget ([ADR-0001](./0001-latency-budget-and-ingestion-model.md)). The latency budget rules out needing a websocket-heavy / Elixir-class real-time stack — a Postgres-backed queue handles the receive → classify → escalate pipeline fine. A single Next.js codebase collapses what would otherwise be three projects (marketing site, dashboard SPA, API) into one, with Vercel preview-per-PR for design partners. The Anthropic Node SDK is first-class and the `claude-api` skill is already loaded for it. Postgres on Neon has a generous free tier and is "boring tech" for the data layer. Each of Twilio, Resend, and pg-boss is the smallest possible moving part for its job.

## Considered options

- **Rails or Django monolith on Render/Fly** — better background-job ergonomics (Sidekiq/Celery) but slower to ship the dashboard UI, less idiomatic LLM SDK, no preview-per-PR loop. Right answer if hiring backend-heavy team.
- **Node/Express + React SPA on AWS** — most control, most YAML/IAM/VPC setup before the first product line. Wrong scale for solo MVP.
- **Phoenix/Elixir + LiveView on Fly** — beautiful real-time dashboards, but our latency budget doesn't need Elixir's real-time strengths and the learning curve eats MVP velocity unless already fluent.

## Consequences

- Vercel cold-starts and serverless function timeouts are real constraints. LLM calls that approach the 10s Vercel hobby/30s pro limit must be queued via pg-boss rather than run inline in the webhook handler.
- pg-boss is sufficient at MVP scale (single-digit Businesses, low-hundreds Reviews/day). When throughput exceeds what a single Vercel function + pg-boss worker can absorb, the migration path is a dedicated worker container on Fly or Render, still consuming the same pg-boss queue. No data-model change required.
- Neon's branching feature pairs nicely with Vercel preview deploys — each PR can get its own database branch if useful.
- The `claude-api` skill in `.claude/skills/` should be the canonical reference for prompt design, caching, and migration.
- Auth: defer the auth-provider choice (Clerk vs Auth.js vs Supabase Auth) until building the signup flow — not a blocking decision today.
