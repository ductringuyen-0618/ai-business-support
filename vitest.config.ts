import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config.
 *
 * - Node environment: the only tests we run today are pure-TS unit tests
 *   against the webhook handler and its dependencies; nothing needs jsdom.
 * - The `@/*` path alias mirrors `tsconfig.json` so test imports look like
 *   production imports.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    globals: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
