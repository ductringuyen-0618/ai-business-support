import path from "node:path";

import type { NextConfig } from "next";

/**
 * In E2E test mode we alias the Clerk SDK packages to local stubs so the dev
 * server can boot without real Clerk API keys. The stubs derive auth identity
 * from a request header that the Playwright spec sets. Production builds NEVER
 * load the stubs — the alias only applies when `E2E_TEST_MODE === "1"`.
 *
 * See `src/lib/test-mode/README.md` for the full mocking strategy.
 */
const E2E = process.env.E2E_TEST_MODE === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pg-boss is a node-only dependency. Make sure Next never tries to bundle it
  // for the edge runtime; it lives only in the worker process and any
  // server-only modules that import it.
  serverExternalPackages: ["pg-boss"],
  webpack(config) {
    if (E2E) {
      const root = path.resolve(__dirname);
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "@clerk/nextjs/server": path.join(root, "src/lib/test-mode/clerk-server-stub.ts"),
        "@clerk/nextjs": path.join(root, "src/lib/test-mode/clerk-client-stub.tsx"),
      };
    }
    return config;
  },
};

export default nextConfig;
