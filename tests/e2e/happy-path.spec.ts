/**
 * Slice 16 — end-to-end happy path.
 *
 * Drives the full Operator journey, asserting on observable app behaviour:
 *
 *   1. Operator is "signed up" — the spec sets a Clerk identity via test-mode
 *      headers, then seeds the Business + Operator rows the Clerk webhook
 *      would have produced. The dashboard's "Hello, {name}" header confirms
 *      identity end-to-end.
 *   2. Operator clicks Connect Google. The route's redirect to Google is
 *      intercepted by Playwright and instead lands on our own callback URL
 *      with a valid signed state cookie and a fake `code`. The handler's
 *      token-exchange is mocked at the source by `E2E_TEST_MODE=1` so no
 *      real Google round-trip happens. A `source_connections` row is
 *      persisted and `backfill_source` is enqueued.
 *   3. The pg-boss worker (booted by `globalSetup`) drains the backfill —
 *      one `ingest_review` per Review on the slice-5 fixture, each calling
 *      the mocked Classifier. Five Reviews land, one of which is an Incident
 *      (the "hair in salad" 2-star — see `src/lib/test-mode/anthropic-mock.ts`).
 *   4. Reviews appear on the dashboard. Theme pills, star ratings, and the
 *      Incident pill are all asserted on.
 *   5. The Operator opens the Incident drawer and clicks Mark resolved.
 *      The nav-bar unresolved-Incidents badge decrements to 0.
 *   6. A mocked Resend `emails.send` call was attempted for the Incident
 *      escalation. We read the recorder file to assert subject + recipient.
 *
 * The whole thing is hermetic — no live HTTP to Google/Anthropic/Resend/Twilio.
 */
import { test, expect, type Page } from "@playwright/test";

import { readMockEvents, resetMockEvents, type MockEvent } from "./setup/mock-recorder";
import { readRuntimeState } from "./setup/runtime-state";
import { countRows, seedBusinessAndOperator, waitForCondition } from "./setup/seed";

const E2E_USER_ID = "user_e2e_happy_path";
const E2E_ORG_ID = "org_e2e_happy_path";
const OPERATOR_EMAIL = "operator@example.test";
const BUSINESS_NAME = "E2E Test Cafe";

/**
 * Apply the test-mode auth headers to every request the browser makes. The
 * stubbed `@clerk/nextjs/server` in `src/lib/test-mode/clerk-server-stub.ts`
 * reads these to derive the signed-in user.
 */
async function setOperatorIdentity(page: Page): Promise<void> {
  await page.setExtraHTTPHeaders({
    "x-e2e-clerk-user-id": E2E_USER_ID,
    "x-e2e-clerk-first-name": "Alex",
    "x-e2e-clerk-username": "alex_op",
    "x-e2e-clerk-email": OPERATOR_EMAIL,
  });
}

test.describe("happy path: signup → connect → see Review", () => {
  test.beforeAll(async () => {
    // Seed the rows the Clerk webhook would have produced post-signup. The
    // existing `tests/webhooks/clerk-events.test.ts` covers the webhook
    // handler in isolation; we don't need to re-prove it here.
    await seedBusinessAndOperator({
      clerkUserId: E2E_USER_ID,
      clerkOrgId: E2E_ORG_ID,
      operatorEmail: OPERATOR_EMAIL,
      businessName: BUSINESS_NAME,
    });
    resetMockEvents();
  });

  test("Operator connects Google, sees Reviews, resolves an Incident, fires an email", async ({
    page,
  }) => {
    const state = readRuntimeState();
    await setOperatorIdentity(page);

    // 1. Dashboard renders with the seeded Operator's identity.
    await page.goto(`${state.serverUrl}/app/dashboard`);
    await expect(page.getByRole("heading", { name: /Hello, Alex/ })).toBeVisible();
    await expect(page.getByText(BUSINESS_NAME)).toBeVisible();
    await expect(page.getByRole("link", { name: /Connect Google/ })).toBeVisible();

    // 2. Intercept the Google redirect. The `start` handler 302s to
    //    `accounts.google.com/...` with `state=` in the query string. We
    //    re-route the navigation directly back to our callback so the test
    //    stays offline. The state cookie was set on that 302 hop, so the
    //    callback's HMAC check passes naturally.
    // Belt-and-braces: abort any external Google traffic that might still try
    // to leak out. In E2E mode the `oauth/start` route already short-circuits
    // to our own callback (see `src/app/api/sources/google/oauth/start/route.ts`),
    // so these aborts only fire if a regression reintroduces a real Google hop.
    const ctx = page.context();
    await ctx.route(
      /^https:\/\/(accounts|www|fonts|gstatic|apis|api)\.google(apis)?\.com/,
      async (route) => {
        await route.abort();
      },
    );

    await Promise.all([
      page.waitForURL(/\/app\/dashboard\?.*flash=google_connected/),
      page.getByRole("link", { name: /Connect Google/ }).click(),
    ]);

    // 3. The source_connections row is persisted; the dashboard now shows
    //    a "Disconnect" button + the "Connected · pending|healthy" pill.
    await expect(page.getByRole("button", { name: /Disconnect/ })).toBeVisible();
    expect(await countRows("source_connections", await businessIdFromSeed())).toBe(1);

    // 4. Wait for the worker to drain the backfill → ingest pipeline. The
    //    slice-5 `single-page.json` fixture carries 5 Reviews; the classifier
    //    fires once per Review (per ADR-0004); each Review yields a Review row
    //    + a Classification row.
    const businessId = await businessIdFromSeed();
    await waitForCondition(async () => (await countRows("reviews", businessId)) >= 5, {
      timeoutMs: 30_000,
      label: "5 Reviews ingested",
    });
    await waitForCondition(async () => (await countRows("classifications", businessId)) >= 5, {
      timeoutMs: 30_000,
      label: "5 Classifications written",
    });
    await waitForCondition(async () => (await countRows("incidents", businessId)) >= 1, {
      timeoutMs: 15_000,
      label: "1 Incident fired",
    });

    // 5. Refresh the dashboard so it picks up the persisted Reviews. The
    //    fixture has one Incident (the "hair in salad" Review classified by
    //    `anthropic-mock.ts` with is_incident=true).
    await page.reload();

    // Theme pills present on the Review row (the filter bar also has a
    // "Cleanliness" button, so we scope to the Reviews region).
    const reviewsRegion = page.getByRole("region", { name: "Reviews" });
    await expect(reviewsRegion.getByText("Cleanliness").first()).toBeVisible();
    await expect(reviewsRegion.getByText("Wait time").first()).toBeVisible();

    // Star rating elements present (aria-labelled by the StarRating component).
    await expect(page.getByLabel(/out of 5 stars/).first()).toBeVisible();

    // 6. Open the Incident drawer.
    // The Incident pill renders as a `<span>` inside a Review row `<button>`.
    // We pick the row whose text contains "Incident" — the slice-5 fixture
    // has exactly one such row (the "hair in salad" Review classified as
    // `is_incident=true` by `src/lib/test-mode/anthropic-mock.ts`).
    const incidentRow = reviewsRegion.getByRole("button").filter({ hasText: "Incident" }).first();
    await expect(incidentRow).toBeVisible();
    await incidentRow.click();
    const drawer = page.getByRole("dialog", { name: "Review details" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Severity", { exact: true })).toBeVisible();
    await expect(drawer.getByText("high", { exact: true })).toBeVisible();

    // 7. Mark resolved.
    await drawer.getByRole("button", { name: /Mark resolved/ }).click();

    // After resolving, the drawer closes and the unresolved-Incidents badge
    // (which was 1) disappears. We wait for the nav to settle.
    await waitForCondition(
      async () => {
        await page.reload();
        // The badge is rendered with aria-label "{n} unresolved Incidents" —
        // when count drops to 0 the badge is removed entirely.
        const badgeCount = await page.locator('[aria-label$="unresolved Incidents"]').count();
        return badgeCount === 0;
      },
      { timeoutMs: 10_000, label: "unresolved-Incidents badge cleared" },
    );

    // 8. Assert the mocked Resend send happened with the expected shape. The
    //    fire_incident → deliver_escalation pipeline sends one email per
    //    Operator (the seeded Operator has no SMS pref so only Email fires).
    const resendEvents = readMockEvents().filter((e: MockEvent) => e.service === "resend");
    expect(resendEvents.length).toBeGreaterThanOrEqual(1);
    const incidentEmail = resendEvents.find((e) => {
      const p = e.payload as { to?: string[]; subject?: string };
      return p.to?.includes(OPERATOR_EMAIL);
    });
    expect(incidentEmail, "expected at least one Resend send to the Operator").toBeTruthy();
    const payload = incidentEmail!.payload as {
      to: string[];
      subject: string;
      html_prefix: string;
    };
    expect(payload.to).toContain(OPERATOR_EMAIL);
    expect(payload.subject.length).toBeGreaterThan(0);
  });
});

/**
 * Resolve the Business UUID we seeded in `beforeAll`. We re-query rather than
 * passing it through `test.use` because Playwright fixtures don't survive
 * across `test()` boundaries.
 */
async function businessIdFromSeed(): Promise<string> {
  const state = readRuntimeState();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const postgres = (await import("postgres")).default;
  const sql = postgres(state.databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM businesses WHERE clerk_org_id = ${E2E_ORG_ID} LIMIT 1
    `;
    if (rows.length === 0) {
      throw new Error("Business row not seeded — beforeAll must run first.");
    }
    return rows[0].id;
  } finally {
    await sql.end({ timeout: 2 });
  }
}
