/**
 * Apply pending Drizzle migrations against Neon.
 *
 * Run via `pnpm db:migrate` after `pnpm db:generate` produced new SQL in
 * `drizzle/`. Uses the unpooled Neon URL because migrations need a real
 * session (e.g. for transactional DDL).
 */
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { closeNodeDb, getNodeDb } from "./node-client";

async function main() {
  const db = getNodeDb();
  console.log("Running drizzle migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
  await closeNodeDb();
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  await closeNodeDb();
  process.exit(1);
});
