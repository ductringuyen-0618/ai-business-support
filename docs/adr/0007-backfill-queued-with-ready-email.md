# Full-history backfill, queued via pg-boss, "dashboard ready" email at ≥95%

When a Business completes the OAuth handshake with a Source, the OAuth callback enqueues a backfill job rather than fetching synchronously. A pg-boss worker pulls Reviews from the Source in pages and runs each through the standard ingest pipeline (redaction → LLM classification → store). The dashboard is reachable immediately but renders a progressive "loaded N of ~M" state. When ≥95% of historical Reviews are loaded, a one-time "your dashboard is ready" email is sent.

## Why

A synchronous backfill at OAuth callback would hang the request for minutes (small Business) to hours (chain location with thousands of Reviews) and is an unacceptable signup UX. A forward-only ingest leaves the dashboard blank for days and destroys the first-impression pitch — when a prospect signs up and immediately sees real historical trends in their Themes, they're hooked. Queued backfill keeps the OAuth callback snappy, leverages the pg-boss queue we're already running ([ADR-0005](./0005-stack-nextjs-neon-vercel.md)), and the per-Review cost (~1¢ × typical SMB volume = $0.50–$5, chains up to ~$30) is cheap relative to the activation value of a populated dashboard.

## Consequences

- The OAuth callback endpoint creates the `SourceConnection` row and enqueues a `backfill_source` job; it returns immediately.
- The backfill worker uses pg-boss with per-Business concurrency limit (default 5) to stay under Anthropic's per-minute token budget. A global cap across all running backfills protects shared quota.
- Each Review is upserted by `(source, source_review_id)` so the backfill is idempotent — partial failures retry safely.
- The dashboard exposes `backfill_status` per `SourceConnection` (`pending`, `running`, `complete`, `failed`) and a `loaded_count` / `estimated_total` pair. Trend charts render with whatever's loaded so far.
- The "ready" email fires once per `SourceConnection`, gated on `loaded_count ≥ 0.95 × estimated_total`. Operators who never open the email still get a fully-loaded dashboard the next time they log in.
- Backfill failures past N retries open an internal alert; Operator sees a banner with a "retry" button. Failures don't block fresh-Review ingestion — that runs on a separate Pub/Sub path.
- Profile photos are not fetched (per [ADR-0006](./0006-pii-redact-before-llm-full-storage.md)).
