/**
 * Playwright global setup for the happy-path E2E spec.
 *
 * Boot order (the order matters; each step depends on the previous):
 *
 *   1. Start an ephemeral Postgres 16 cluster (`tests/e2e/setup/postgres.ts`).
 *      Random port, temp data dir, fsync-off for speed.
 *   2. Run Drizzle migrations against it (`pnpm db:migrate`). Bootstraps every
 *      table the app touches.
 *   3. Write `tests/e2e/.runtime.json` so the spec + teardown can read the
 *      shared state (DB URL, mock-recorder path, server URL).
 *   4. Start the Next dev server with `E2E_TEST_MODE=1` so it loads the Clerk
 *      stubs and the mock SDK clients. Wait for `/api/health` to 200.
 *   5. Start the pg-boss worker (same env) so backfill / ingest / fire-incident
 *      / deliver-escalation jobs drain.
 *
 * Teardown (`./global-teardown.ts`) reverses this in order.
 *
 * Performance budget: the whole boot takes about 5–8s on a dev laptop (initdb
 * dominates). The spec runs in <10s. Total wall-clock comfortably <60s.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrateTempPostgres, startTempPostgres, type TempPostgresHandle } from "./postgres";
import { runtimeStatePath, type RuntimeState } from "./runtime-state";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

interface BootedServer {
  proc: ChildProcess;
  url: string;
  port: number;
}

interface BootedHandles {
  pg: TempPostgresHandle;
  dev: BootedServer;
  worker: ChildProcess;
}

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "localhost", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not pick a free port")));
      }
    });
  });
}

async function waitForHttp200(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error(`Timed out after ${elapsed}ms waiting for ${url}`);
    }
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(url, { timeout: 1500 }, (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function buildEnv(state: RuntimeState): NodeJS.ProcessEnv {
  // Anything the dev server / worker reads at runtime needs to be present
  // here. We intentionally clear ANTHROPIC_API_KEY / RESEND_API_KEY etc. —
  // the mocks short-circuit before the SDK clients try to read them, but if
  // a real key were present a future regression could accidentally hit the
  // real network. Belt-and-braces.
  return {
    ...process.env,
    NODE_ENV: "test" as const,
    E2E_TEST_MODE: "1",
    E2E_MOCK_RECORDER_PATH: state.mockRecorderPath,
    DATABASE_URL: state.databaseUrl,
    DATABASE_URL_UNPOOLED: state.databaseUrl,
    APP_BASE_URL: state.serverUrl,
    NEXT_PUBLIC_APP_BASE_URL: state.serverUrl,
    // Source-token encryption key — 32 bytes base64.
    SOURCE_TOKEN_ENCRYPTION_KEY: "qoOLwHwhKHWqW9zVQukf8m9sBg/wxhMNzcLfvtKAcKE=",
    // GoogleAdapter fixture mode (slice 5).
    GOOGLE_ADAPTER_MODE: "fixture",
    GOOGLE_OAUTH_CLIENT_ID: "e2e-google-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "e2e-google-secret",
    GOOGLE_PUBSUB_VERIFICATION_TOKEN: "e2e-pubsub-token",
    // Clerk publishable + signing keys — read by ClerkProvider's runtime even
    // though our stub ignores them. Set to nonsense values so the package
    // doesn't bail out before our alias replaces it.
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_e2e",
    CLERK_SECRET_KEY: "sk_test_e2e",
    CLERK_WEBHOOK_SIGNING_SECRET: "whsec_e2e",
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
    NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: "/app/dashboard",
    NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: "/app/dashboard",
    // Real keys explicitly cleared so any code path that bypasses our mock
    // explodes fast instead of silently calling out to the internet.
    ANTHROPIC_API_KEY: "",
    RESEND_API_KEY: "",
    TWILIO_ACCOUNT_SID: "",
    TWILIO_AUTH_TOKEN: "",
    TWILIO_FROM_NUMBER: "",
    ADMIN_USER_IDS: "user_e2e_admin",
    INTERNAL_ADMIN_KEY: "e2e-internal-admin-key",
  };
}

async function startDevServer(env: NodeJS.ProcessEnv): Promise<BootedServer> {
  const port = await pickFreePort();
  const url = `http://localhost:${port}`;
  const proc = spawn(
    "pnpm",
    ["exec", "next", "dev", "--port", String(port), "--hostname", "localhost"],
    {
      env: { ...env, PORT: String(port) },
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Surface server output to the Playwright reporter — vital when debugging
  // a failure trace, invisible noise otherwise.
  proc.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[next] ${chunk}`);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[next] ${chunk}`);
  });

  await waitForHttp200(`${url}/api/health`, 90_000);
  return { proc, url, port };
}

function startWorker(env: NodeJS.ProcessEnv): ChildProcess {
  const proc = spawn("pnpm", ["exec", "tsx", "src/worker/index.ts"], {
    env,
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[worker] ${chunk}`);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[worker] ${chunk}`);
  });
  return proc;
}

export default async function globalSetup(): Promise<void> {
  console.log("[e2e setup] starting ephemeral Postgres ...");
  const pg = await startTempPostgres();
  console.log(`[e2e setup] Postgres up on port ${pg.port}`);

  console.log("[e2e setup] applying migrations ...");
  await migrateTempPostgres(pg.url);
  console.log("[e2e setup] migrations applied");

  // Mock recorder file in tempdir.
  const recorderDir = await mkdtemp(path.join(tmpdir(), "ai-bus-e2e-mock-"));
  const mockRecorderPath = path.join(recorderDir, "events.jsonl");
  await writeFile(mockRecorderPath, "");

  const tentativeState: RuntimeState = {
    databaseUrl: pg.url,
    pgDataDir: pg.dataDir,
    mockRecorderPath,
    serverUrl: "http://localhost:0", // filled in below
    devPid: 0,
    workerPid: 0,
  };

  console.log("[e2e setup] starting Next dev server ...");
  const dev = await startDevServer(buildEnv(tentativeState));
  console.log(`[e2e setup] dev server up at ${dev.url}`);

  const finalState: RuntimeState = {
    ...tentativeState,
    serverUrl: dev.url,
    devPid: dev.proc.pid ?? 0,
    workerPid: 0,
  };

  console.log("[e2e setup] starting pg-boss worker ...");
  const worker = startWorker(buildEnv(finalState));
  finalState.workerPid = worker.pid ?? 0;
  // Give the worker a brief moment to subscribe to its queues. The dev server
  // is already ready, so a short sleep here doesn't block the user flow.
  await new Promise((r) => setTimeout(r, 1500));
  console.log("[e2e setup] worker started");

  await writeFile(runtimeStatePath(), JSON.stringify(finalState, null, 2));

  // Stash handles in the module scope so teardown can find them. Playwright
  // re-imports the teardown file, so we cannot share JS objects — but
  // `RuntimeState` on disk has the pids we need.
  (globalThis as { __E2E_HANDLES__?: BootedHandles }).__E2E_HANDLES__ = {
    pg,
    dev,
    worker,
  };
}
