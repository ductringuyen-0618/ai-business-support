# ai-business-support

A self-serve B2B SaaS that aggregates customer Reviews for a Business from external Sources
(Google Business Profile in MVP), surfaces Themes and Incidents, and notifies the Business's
Operators by Email and SMS.

See [`CONTEXT.md`](./CONTEXT.md) for the canonical glossary — use those terms verbatim throughout
the codebase. See [`docs/adr/`](./docs/adr/) for the architectural decisions that pin down the
stack and the product shape.

## Stack

Locked by [ADR-0005](./docs/adr/0005-stack-nextjs-neon-vercel.md) and
[ADR-0009](./docs/adr/0009-clerk-for-auth.md):

- **Framework**: Next.js 15 (TypeScript, App Router)
- **Auth**: Clerk (Organizations map to Businesses; Clerk users map to Operators)
- **Database**: Neon Postgres
  - `@neondatabase/serverless` for the HTTP runtime (Next.js route handlers / server components)
  - `postgres` (postgres-js) for long-lived connections (worker + migrator)
- **ORM / migrations**: [Drizzle ORM](https://orm.drizzle.team/) + `drizzle-kit`
- **Background jobs**: [pg-boss](https://github.com/timgit/pg-boss) v10, against the same Neon DB
- **Styling**: Tailwind CSS v3
- **Deploy**: Vercel (preview-per-PR), with the pg-boss worker run as a separate long-running
  process (Fly / Render / a Vercel cron — _to be decided in a follow-up slice_)

Subsequent slices add the Anthropic SDK (Classifier, DigestComposer), Resend (Email Channel),
Twilio (SMS Channel), and Google Business Profile (`SourceAdapter`).

## Why Drizzle?

Slice 1's `README.md` decision: Drizzle was picked over Kysely / raw SQL files because (a) the
schema-as-code TypeScript model gives later slices `Business` / `Operator` row types for free,
(b) `drizzle-kit generate` produces deterministic, reviewable SQL migration files we commit to
`drizzle/`, and (c) it's idiomatic for the Next.js + Neon stack. The generated SQL is plain
Postgres — switching to raw SQL or Kysely later would be a mechanical re-export.

## Repository layout

```
.
├── src/
│   ├── app/                       # Next.js App Router
│   │   ├── layout.tsx             # root layout (wraps in ClerkProvider)
│   │   ├── page.tsx               # public marketing root
│   │   ├── sign-in/[[...sign-in]]/page.tsx
│   │   ├── sign-up/[[...sign-up]]/page.tsx
│   │   ├── app/                   # everything under /app/* is auth-gated
│   │   │   ├── layout.tsx         # signed-in shell (UserButton, nav)
│   │   │   └── dashboard/page.tsx # "Hello, {Operator name}"
│   │   └── api/
│   │       ├── health/route.ts    # liveness probe
│   │       ├── ping/route.ts      # smoke-test pg-boss enqueue
│   │       └── sources/           # Slice 8: Google OAuth + disconnect
│   │           ├── google/oauth/start/route.ts
│   │           ├── google/oauth/callback/route.ts
│   │           └── [id]/disconnect/route.ts
│   ├── middleware.ts              # Clerk auth middleware: protects /app/*
│   ├── db/
│   │   ├── schema.ts              # Drizzle schema (Businesses + Operators)
│   │   ├── client.ts              # neon-http drizzle client (Next runtime)
│   │   ├── node-client.ts         # postgres-js drizzle client (worker, migrator)
│   │   └── migrate.ts             # `pnpm db:migrate` entrypoint
│   ├── queue/
│   │   ├── boss.ts                # pg-boss singleton + lifecycle helpers
│   │   └── handlers/
│   │       └── ping.ts            # no-op smoke-test job handler
│   └── worker/
│       └── index.ts               # `pnpm worker` entrypoint
├── drizzle/                       # generated SQL migrations (checked in)
├── docs/adr/                      # architectural decision records
├── CONTEXT.md                     # canonical glossary
├── .env.example                   # every env var the project expects
├── drizzle.config.ts
├── tailwind.config.ts
├── next.config.ts
└── package.json
```

## Setup

You need:

- Node.js **>= 20** (this project pins `pnpm@10` via `packageManager`).
- A free [Neon](https://neon.tech/) account — create a project, copy the pooled + unpooled
  connection strings.
- A free [Clerk](https://clerk.com/) account — create an Application and copy its publishable +
  secret keys.

```sh
# install dependencies
pnpm install

# copy the env template and fill in real values
cp .env.example .env.local
$EDITOR .env.local
```

At minimum, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and
`CLERK_SECRET_KEY` must be set for Slice 1 to boot.

The Slice 8 Google OAuth flow additionally requires `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, and `SOURCE_TOKEN_ENCRYPTION_KEY`. See
[Google Cloud setup (Slice 8)](#google-cloud-setup-slice-8) below.

### Google Cloud setup (Slice 8)

To exercise the Google Business Profile connect flow you need a Google Cloud project with the
Business Profile API enabled and an OAuth 2.0 client whose redirect URI points at this app.

1. **Create / pick a Google Cloud project.** [`console.cloud.google.com`](https://console.cloud.google.com/)
   → top bar → "New Project". Any project will do.
2. **Enable the Business Profile API.** APIs & Services → Library → search for
   "Business Profile API" → Enable.
   - Public access to the API requires Google to approve your usage; the request form lives at
     [Google's My Business API quota form](https://docs.google.com/forms/d/e/1FAIpQLSf67UpgHyjUyrtRzlsBnplmGcfBOY9XAfdosBHbS-LFkRzgxA/viewform).
     You can develop end-to-end against a single test Business while the request is in flight.
3. **Configure the OAuth consent screen.** APIs & Services → OAuth consent screen.
   - User type: External.
   - App name, support email, developer contact — required by Google but never shown to your
     Operators during the dev test flow.
   - Scopes: add `https://www.googleapis.com/auth/business.manage` (read-only — per
     [ADR-0003](./docs/adr/0003-llm-drafted-replies-no-auto-post.md), we never request write
     scopes).
   - Add the email addresses of any test Operators while the consent screen is in "Testing".
4. **Create an OAuth 2.0 Client ID.** APIs & Services → Credentials → "Create credentials" →
   "OAuth client ID" → Application type "Web application".
   - Authorized redirect URIs:
     - `http://localhost:3000/api/sources/google/oauth/callback` (local dev)
     - `https://<your-vercel-url>/api/sources/google/oauth/callback` (production)
   - Save. Copy the **Client ID** and **Client secret**.
5. **Generate a token-encryption key.** The app encrypts OAuth tokens at rest with AES-256-GCM:

   ```sh
   node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
   ```

6. **Add the values to `.env.local`** (the same names also need to be set in Vercel for
   Production + Preview):

   ```env
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   SOURCE_TOKEN_ENCRYPTION_KEY=<output from step 5>
   ```

   See [`.env.example`](./.env.example) for the full list.

7. **Apply the migration** (creates the `source_connections` table):

   ```sh
   pnpm db:migrate
   ```

8. **Try the flow.** `pnpm dev`, sign in, click "Connect Google" on the dashboard. After the
   consent screen you should land back at `/app/dashboard?flash=google_connected` with a
   "Connected" pill and a "Disconnect" button.

### Pub/Sub setup (Slice 10)

Slice 10 adds two ingest paths that both funnel into the slice-9 `ingest_review` queue:

- **Backfill**: a `backfill_source` pg-boss job walks every historical Review for a
  newly-connected Business via paginated `GoogleAdapter.ingestPage` calls. The worker
  (`pnpm worker`) drains this queue alongside `ingest_review`. See
  [ADR-0007](./docs/adr/0007-backfill-queued-with-ready-email.md) for the queued-with-ready-email
  UX. Operators receive a one-time "your dashboard is ready" email via Resend once the
  backfill crosses ≥95% loaded (configured via `RESEND_API_KEY`, optional
  `EMAIL_FROM_ADDRESS`).
- **Live**: Google Business Profile pushes a Pub/Sub notification at
  `POST /api/webhooks/google/pubsub` whenever a new Review appears. The webhook decodes
  the push payload, resolves the affected SourceConnection by Google `locationId`, and
  enqueues one `ingest_review` job per new Review. Pub/Sub re-delivers on any non-2xx
  response — the handler is idempotent against this via the `processed_pubsub_messages`
  table keyed on the Pub/Sub `messageId`.

Wiring the live path requires a Google Cloud Pub/Sub topic + push subscription pointed at
this app:

1. **Create the topic.** In your Google Cloud project (the same one that hosts the OAuth
   client from the Slice 8 runbook above): Pub/Sub → Topics → "Create topic". Name it
   something like `gbp-review-notifications`.
2. **Grant Google Business Profile permission to publish.** On the topic's Permissions
   tab, add `mybusiness-api-pubsub@system.gserviceaccount.com` with the **Pub/Sub
   Publisher** role. (Google's documented service account for Business Profile
   notifications.)
3. **Generate a verification token.**

   ```sh
   node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'
   ```

   Put the value in your environment as `GOOGLE_PUBSUB_VERIFICATION_TOKEN` (locally in
   `.env.local`; on Vercel for both Production and Preview).

4. **Create a push subscription.** Subscriptions → "Create subscription".
   - Delivery type: **Push**.
   - Endpoint URL:
     `${APP_BASE_URL}/api/webhooks/google/pubsub?token=${GOOGLE_PUBSUB_VERIFICATION_TOKEN}`
     For example: `https://your-app.vercel.app/api/webhooks/google/pubsub?token=abc123`.
     The webhook also accepts the token via `Authorization: Bearer <token>` if you
     prefer header-based auth (configure the subscription with an authentication token).
   - Ack deadline: 60 seconds is plenty — the webhook stamps the messageId and enqueues
     work synchronously before responding.
5. **Link Business Profile to the topic.** Configure your connected Business Profile
   account to send Review notifications to the Pub/Sub topic. See Google's runbook at
   [Pub/Sub notifications for the Business Profile API](https://developers.google.com/my-business/content/notification-setup).
6. **Smoke-test.** Pub/Sub's "Test" button in the console sends a synthetic push;
   confirm the webhook returns **204 No Content**. A second click with the same message
   id should also return 204 (idempotent re-delivery — `processed_pubsub_messages`
   catches it).

Local development with `ngrok` is the easiest way to receive real push deliveries before
deploying:

```sh
pnpm dev                          # http://localhost:3000
ngrok http 3000                   # in a second terminal
# Use the ngrok https URL as the subscription endpoint in step 4 above.
```

Env vars introduced or used by Slice 10:

- `GOOGLE_PUBSUB_VERIFICATION_TOKEN` — shared secret between the Pub/Sub subscription
  and this app's webhook.
- `RESEND_API_KEY` — used for the "your dashboard is ready" email at ≥95% backfill
  completion.
- `EMAIL_FROM_ADDRESS` _(optional)_ — sender for outbound mail; defaults to a Resend
  sandbox address that works without a verified domain.
- `APP_BASE_URL` — already required by earlier slices; the "ready" email deep-links to
  `${APP_BASE_URL}/app/dashboard`.

## Running

### Web app (Next.js)

```sh
pnpm dev          # http://localhost:3000
```

- `/` — public marketing root with sign-in / sign-up buttons.
- `/sign-in` and `/sign-up` — Clerk-hosted catch-all routes.
- `/app/dashboard` — authenticated; unauthenticated visitors are redirected to `/sign-in`.
- `/api/health` — unauthenticated liveness probe; returns `{ ok: true, ... }`.
- `/api/ping` — `POST` to enqueue a `ping` job onto pg-boss (see worker below).

### Background worker (pg-boss)

The worker lives in a separate Node process — long-lived, holds a real Postgres connection to
the unpooled Neon URL, and consumes jobs from the `pgboss.*` schema in the same database the
web app uses.

```sh
pnpm worker       # subscribes to the `ping` queue (more in later slices)
```

In a second terminal:

```sh
curl -X POST http://localhost:3000/api/ping -H 'content-type: application/json' \
  -d '{"message":"hello"}'
# expect: {"ok":true,"jobId":"...","message":"hello"}
```

The worker terminal should log a `[worker] ping received id=... message="hello"` line within a
few seconds — proves the queue round-trip works.

### Database migrations

We use Drizzle Kit. The first migration (`drizzle/0000_init_businesses_and_operators.sql`)
creates the `businesses` and `operators` tables.

```sh
pnpm db:migrate        # apply pending migrations against DATABASE_URL_UNPOOLED
pnpm db:generate       # after editing src/db/schema.ts, regenerate SQL
pnpm db:studio         # optional: drizzle-kit studio GUI at https://local.drizzle.studio
```

Migrations always run against the **unpooled** Neon URL (`DATABASE_URL_UNPOOLED`) because they
need transactional DDL and the pooler sometimes refuses the catalog reads `drizzle-kit` needs.

## Quality gates

```sh
pnpm typecheck         # tsc --noEmit
pnpm lint              # next lint (ESLint + next/typescript + prettier-compat)
pnpm format            # prettier --write .
pnpm format:check      # prettier --check . (used in CI)
pnpm build             # production build; catches a different class of issue than dev
```

All four pass on this slice. Tests are out of scope for the bootstrap (subsequent slices add
unit + integration tests for their modules).

## Deploying to Vercel

1. Push the repo to GitHub and import it in the [Vercel dashboard](https://vercel.com/new).
2. Set the env vars from `.env.example` in Vercel's project settings (Production + Preview):
   - `DATABASE_URL`, `DATABASE_URL_UNPOOLED` (Neon)
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`
   - `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`,
     `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`,
     `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/app/dashboard`,
     `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/app/dashboard`
   - `APP_BASE_URL` (e.g. `https://your-app.vercel.app`)
   - Slice 8 adds: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
     `SOURCE_TOKEN_ENCRYPTION_KEY` — see
     [Google Cloud setup (Slice 8)](#google-cloud-setup-slice-8).
   - The remaining keys (Anthropic, Resend, Twilio) are not required yet but should be added
     before later slices ship.
3. Deploy. The first build will fail-fast if any required env var is missing.
4. Run migrations against your production Neon DB once after the first deploy:

   ```sh
   DATABASE_URL_UNPOOLED=<prod-neon-direct-url> pnpm db:migrate
   ```

5. The pg-boss **worker is not deployed by Vercel** in Slice 1 — Vercel functions are
   short-lived. Run it on a host that supports long-lived processes (Render / Fly /
   `pnpm worker` on a dev box) using the same `DATABASE_URL_UNPOOLED`. Picking that host is a
   later-slice decision.

## Resend + Twilio setup (Slice 11)

Slice 11 wires the Email + SMS Channels for Escalations. Both wrappers
(`src/lib/email/resend.ts` and `src/lib/sms/twilio.ts`) lazily initialise from
env vars, so the worker only fails at the moment of the first send if a key is
missing — local development can run the rest of the pipeline without either
service configured.

### Resend (Email)

1. Sign up at https://resend.com and create an API key (Settings → API Keys).
2. Add a verified sending domain (Domains → Add Domain). Use whatever hostname
   matches your `APP_BASE_URL` — the default `from` address is
   `notifications@<APP_BASE_URL host>`.
3. Drop the key into `.env.local`:

   ```sh
   RESEND_API_KEY=re_xxx
   ```

4. To test locally without a verified domain, you can route mail to
   `delivered@resend.dev` (Resend's sink address) and watch deliverability in
   the Resend dashboard. To bypass sending entirely in unit tests, inject a
   stub `ResendEmailClient` via `sendEmail(input, { client })`.

### Twilio (SMS)

1. Sign up at https://www.twilio.com/ and provision a phone number capable of
   sending SMS in your target market.
2. Note your Account SID + Auth Token from the Twilio Console home page.
3. Drop them into `.env.local`:

   ```sh
   TWILIO_ACCOUNT_SID=ACxxx
   TWILIO_AUTH_TOKEN=xxx
   TWILIO_FROM_NUMBER=+15555550123
   ```

4. The phone-verification round-trip (Operator settings UI) sends a 6-digit
   code via this same Twilio account, so verifying a developer phone in the
   UI is a good smoke-test that the SMS pipeline works.

### Operator Channel preferences

Sign in, click "Channels" in the app header. Email is on by default and always
available (per [ADR-0009](./docs/adr/0009-clerk-for-auth.md)); SMS is opt-in
and requires phone verification. Quiet hours and IANA timezone are settable
per-Channel.

## Non-negotiable safety rules

Per PRD #1 — these apply to every PR:

1. **All Source-facing OAuth must be read-only.** Reopening requires a new ADR superseding
   [ADR-0003](./docs/adr/0003-llm-drafted-replies-no-auto-post.md).
2. **All LLM-bound text must pass through `Redactor`.** No code path may send Review text to
   Anthropic without redaction (enforced in `Classifier` / `DigestComposer` interfaces in
   later slices).
3. **All data queries must filter by `business_id` from the current Operator's session.** A
   repository abstraction enforces this — direct SQL outside the abstraction needs explicit
   justification in the PR description.

## Further reading

- [`CONTEXT.md`](./CONTEXT.md) — the glossary. Use these terms verbatim.
- [`docs/adr/`](./docs/adr/) — every locked architectural decision.
- [PRD #1](https://github.com/ductringuyen-0618/ai-business-support/issues/1) — the product
  spec this codebase implements.
