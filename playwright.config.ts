/**
 * Playwright configuration for the slice-16 E2E spec.
 *
 * The `globalSetup` boots an ephemeral Postgres + Next dev server + pg-boss
 * worker before any spec runs; `globalTeardown` reverses it. See
 * `tests/e2e/setup/` for the wiring.
 *
 * The `use.baseURL` is loaded lazily from the runtime-state file the setup
 * writes — we can't know the dev server's port until it boots (it picks a
 * free one). Each spec resolves `baseURL` via `test.beforeAll` and a hand-
 * configured `page.goto(...)`.
 *
 * Failure artefacts: trace on first retry, screenshot on failure. Both ship
 * to `playwright-report/` which CI can upload as build artefacts (when CI
 * lands — see README.md "End-to-end tests").
 */
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  // Generous timeout so the single happy-path spec has breathing room when the
  // worker is draining pg-boss queues. Individual `expect` calls still respect
  // their default 5s.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: path.resolve(__dirname, "tests/e2e/setup/global-setup.ts"),
  globalTeardown: path.resolve(__dirname, "tests/e2e/setup/global-teardown.ts"),
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // We intercept `accounts.google.com` via `page.route`; ignore cert errors
    // so the intercept fires even if Chrome would otherwise reject the
    // certificate first.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
