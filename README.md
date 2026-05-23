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
│   │       └── ping/route.ts      # smoke-test pg-boss enqueue
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
   - The remaining keys (Anthropic, Google, Resend, Twilio) are not required for Slice 1 but
     should be added before later slices ship.
3. Deploy. The first build will fail-fast if any required env var is missing.
4. Run migrations against your production Neon DB once after the first deploy:

   ```sh
   DATABASE_URL_UNPOOLED=<prod-neon-direct-url> pnpm db:migrate
   ```

5. The pg-boss **worker is not deployed by Vercel** in Slice 1 — Vercel functions are
   short-lived. Run it on a host that supports long-lived processes (Render / Fly /
   `pnpm worker` on a dev box) using the same `DATABASE_URL_UNPOOLED`. Picking that host is a
   later-slice decision.

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
