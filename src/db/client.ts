/**
 * Database client for the Next.js runtime.
 *
 * Uses @neondatabase/serverless against the *pooled* Neon URL. Safe to import
 * from server components, route handlers, and server actions. Do NOT import
 * from the pg-boss worker — that uses `src/db/node-client.ts` instead, which
 * holds a long-lived `postgres` pool against the unpooled URL.
 *
 * E2E hook: when `E2E_TEST_MODE=1` we point at the ephemeral local Postgres
 * via the `postgres-js` driver instead. The neon-http driver assumes a
 * `*.neon.tech` host shape; pointing it at `127.0.0.1` produces opaque URL
 * parse errors. Swapping drivers is one line and keeps the Drizzle query
 * surface identical (both expose `select` / `insert` / etc. with the same
 * schema-typed return).
 */
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill in the Neon pooled connection string.",
    );
  }
  return url;
}

// Both drivers expose the same Drizzle query surface, but TypeScript can't
// prove that as a union (overloads vary slightly between drivers, so the
// narrowed call signatures collapse). We pin the public type to the neon-http
// shape — which is what production runs — and cast the postgres-js client to
// the same type in test mode. Behaviourally identical for the queries the
// app uses.
type Db = ReturnType<typeof drizzleNeon<typeof schema>>;

// Lazily build the client so importing this module at edge build-time (with no
// env vars yet) doesn't crash. The first runtime caller initialises it.
let _db: Db | undefined;

export function getDb(): Db {
  if (!_db) {
    if (process.env.E2E_TEST_MODE === "1") {
      const sql = postgres(getDatabaseUrl(), { max: 5 });
      _db = drizzlePostgres(sql, { schema }) as unknown as Db;
    } else {
      const sql = neon(getDatabaseUrl());
      _db = drizzleNeon(sql, { schema });
    }
  }
  return _db;
}

export { schema };
