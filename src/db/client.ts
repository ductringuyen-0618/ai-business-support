/**
 * Database client for the Next.js runtime.
 *
 * Uses @neondatabase/serverless against the *pooled* Neon URL. Safe to import
 * from server components, route handlers, and server actions. Do NOT import
 * from the pg-boss worker — that uses `src/db/node-client.ts` instead, which
 * holds a long-lived `postgres` pool against the unpooled URL.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

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

// Lazily build the client so importing this module at edge build-time (with no
// env vars yet) doesn't crash. The first runtime caller initialises it.
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  if (!_db) {
    const sql = neon(getDatabaseUrl());
    _db = drizzle(sql, { schema });
  }
  return _db;
}

export { schema };
