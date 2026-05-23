/**
 * Long-lived database client for the pg-boss worker and other Node processes.
 *
 * Uses `postgres` (postgres-js) against Neon's *unpooled* URL so we can hold
 * connections open for the lifetime of the worker. The Next.js runtime uses
 * `./client.ts` instead.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import * as schema from "./schema";

function getUnpooledUrl(): string {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL_UNPOOLED (or DATABASE_URL as fallback) must be set for the worker / migrator.",
    );
  }
  return url;
}

let _sql: ReturnType<typeof postgres> | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getNodeSql() {
  if (!_sql) {
    _sql = postgres(getUnpooledUrl(), { max: 5 });
  }
  return _sql;
}

export function getNodeDb() {
  if (!_db) {
    _db = drizzle(getNodeSql(), { schema });
  }
  return _db;
}

export async function closeNodeDb() {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = undefined;
    _db = undefined;
  }
}
