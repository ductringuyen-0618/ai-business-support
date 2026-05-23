import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pg-boss is a node-only dependency. Make sure Next never tries to bundle it
  // for the edge runtime; it lives only in the worker process and any
  // server-only modules that import it.
  serverExternalPackages: ["pg-boss"],
};

export default nextConfig;
