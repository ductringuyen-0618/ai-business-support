import type { Config } from "drizzle-kit";

// Migrations and drizzle-kit always run against the unpooled (direct) Neon URL.
// Pooled connections sometimes refuse the catalog reads drizzle-kit needs.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "drizzle.config.ts: DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL must be set.",
  );
}

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  // Keep noise out of stdout; drizzle prints to stderr for warnings.
  verbose: false,
  strict: true,
} satisfies Config;
