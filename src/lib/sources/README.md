# `src/lib/sources/` — SourceAdapters

This module defines `SourceAdapter`, the interface every external review
platform plugs into, and `GoogleAdapter`, the first (and currently only)
implementation.

See `CONTEXT.md` for the canonical glossary. Quick reminder:

- **Source**: an external review platform (Google, Yelp, Facebook).
- **Review**: one piece of public feedback from a Reviewer about a Business.
- **Reviewer**: the end-customer who posted the Review.

## Interface contract

```ts
interface SourceAdapter {
  ingestPage(
    connection: SourceConnection,
    pageToken?: string,
  ): Promise<{ reviews: Review[]; nextPageToken?: string }>;

  subscribeForUpdates(connection: SourceConnection): Promise<void>;
}
```

- `ingestPage` is the unit-of-work for the `backfill_source` job
  ([ADR-0007](../../../docs/adr/0007-backfill-queued-with-ready-email.md)).
  One page per job dispatch keeps each pg-boss retry cheap and idempotent.
  The caller drives pagination: feed the returned `nextPageToken` back in
  until it's `undefined`.
- `subscribeForUpdates` sets up the Source's push mechanism (Google's
  Pub/Sub topic). Called once per `SourceConnection`; landed in slice 10.

### Errors

| Error               | When                                                             | Caller's job                                                             |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `TokenExpiredError` | Source rejected the access token.                                | Refresh via refresh token, mark errored, or prompt re-auth (slice 8/10). |
| `RateLimitError`    | Source returned 429 and the adapter's retry budget is exhausted. | Let pg-boss reschedule. Do not retry inside the handler.                 |

Adapters **swallow** transient 429s using exponential backoff (1s → 2s → 4s,
max 3 retries). Only an exhausted retry budget surfaces `RateLimitError`.

### Review shape

```ts
interface Review {
  source_review_id: string; // stable id from the Source
  star_rating: number; // 1..5
  review_text: string | null; // null on star-only or redacted Reviews
  reviewer_display_name: string | null;
  posted_at: Date; // RFC 3339 from the platform
  google?: { update_time?: string; review_reply?: string };
}
```

Downstream handlers MUST tolerate `review_text === null`:

- A Reviewer can leave a 5-star Review with no text on Google.
- After a Reviewer Deletion Request
  ([ADR-0006](../../../docs/adr/0006-pii-redact-before-llm-full-storage.md)),
  the Review row is kept (so trend integrity is preserved) but
  `review_text` and `reviewer_display_name` are nulled in place.

The Redactor (slice 3) treats null text as a no-op; the Classifier (slice 4)
skips classification and falls back to a star-only Theme heuristic.

## `GoogleAdapter` modes

The adapter has two modes, toggled by `GOOGLE_ADAPTER_MODE`:

| Mode      | Behaviour                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| `fixture` | Reads recorded JSON from `__fixtures__/google/`. Default.                                                   |
| `live`    | Calls Google Business Profile API. **Stubbed in this slice**; landed in slice 10 alongside OAuth + Pub/Sub. |

The default is `fixture`, so CI / local dev / preview environments never
accidentally hit Google.

### Enabling live mode (later slices)

Slice 10 will fill in the `live` branch. To turn it on:

```bash
GOOGLE_ADAPTER_MODE=live
# plus Google OAuth client id/secret + GCP project id wired in slice 8.
```

Until then, `mode: "live"` throws `NotImplemented` from `ingestPage`.

### Fixture selection

In `fixture` mode the adapter picks which JSON to load based on `pageToken`,
so tests can deterministically request any scenario:

| `pageToken`            | Fixture file                 | Scenario                          |
| ---------------------- | ---------------------------- | --------------------------------- |
| `undefined`            | `single-page.json`           | 5 Reviews, last page              |
| `"empty"`              | `empty-profile.json`         | Brand-new Business, no Reviews    |
| `"expired-token"`      | `expired-token.json`         | Throws `TokenExpiredError`        |
| `"rate-limit"`         | `rate-limit.json`            | 429 every call → `RateLimitError` |
| `"rate-limit-then-ok"` | `rate-limit` → `single-page` | 429 first, success on retry       |
| `"multi-page"`         | `multi-page-1.json`          | Page 1 of 3                       |
| `"page-2-token"`       | `multi-page-2.json`          | Page 2 of 3                       |
| `"page-3-token"`       | `multi-page-3.json`          | Page 3 of 3 (no `nextPageToken`)  |

The pagination chain (`multi-page` → `page-2-token` → `page-3-token`) is
driven by the `nextPageToken` baked into the fixtures, so the caller doesn't
need to know fixture names — it just feeds the returned token back in.

Unknown `pageToken` values fall back to `empty-profile.json` so tests fail
loudly only when they assert on real data.

### Backoff and the injected clock

`ingestPage` retries on `RateLimitError` with exponential backoff (1s, 2s,
4s, then surfaces to the caller). Tests inject a `Clock` so the retries
don't actually sleep:

```ts
const clock = {
  calls: [] as number[],
  sleep: async (ms: number) => {
    clock.calls.push(ms);
  },
};
const adapter = new GoogleAdapter({ mode: "fixture", clock });
```

## Adding a new adapter (e.g. Yelp)

1. Add `"yelp"` to the `SourceConnection.source` union in `source-adapter.ts`.
2. Create `src/lib/sources/yelp-adapter.ts` implementing `SourceAdapter`.
3. Mirror the directory layout: fixtures under
   `src/lib/sources/__fixtures__/yelp/`, tests under
   `src/lib/sources/__tests__/yelp-adapter.test.ts`.
4. Match the Yelp Fusion API's actual response shape in your fixtures (we do
   not invent synthetic shapes — fixture mode and live mode share one mapper).
5. Wire the adapter into the ingest pipeline's `SourceConnection.source`
   switch (lands with slice 8).

The ingest pipeline never imports a concrete adapter — it depends on
`SourceAdapter` only, so plugging a new Source in does not touch the
pipeline.
