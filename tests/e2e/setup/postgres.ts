/**
 * Spin up an ephemeral Postgres 16 cluster for the E2E test run.
 *
 * Strategy chosen (see slice-16 PR notes): Docker isn't available in every
 * developer sandbox, but `postgresql-16` is installable as a system package on
 * any Ubuntu LTS / macOS Homebrew. We use `initdb` to materialise a fresh data
 * directory under a temp folder, then `pg_ctl start` against it on a free TCP
 * port. The whole thing lives in this process's tempdir and is torn down by
 * `pg_ctl stop` (or, on hard kill, the OS reaper) in `globalTeardown`.
 *
 * Why not Neon test branches? They'd be more production-like, but they require
 * external credentials and network egress. For an MVP-grade safety net the
 * local cluster is faster and offline-safe.
 *
 * Why not pglite / pg-mem? Drizzle's `postgres-js` dialect (used by the worker)
 * + the `neon-http` dialect (used by the runtime) both expect a real TCP
 * Postgres on the other end. A real cluster keeps the boundary identical to
 * production; the cost is one extra system dependency.
 */
import { spawn } from "node:child_process";
import { exec as execCb } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);

/**
 * `initdb` refuses to run as root for safety. On Linux dev sandboxes where
 * the agent runs as root (common in containerised CI), we shell every pg
 * command through `sudo -u postgres -E`. On macOS/Linux dev laptops where
 * the user is unprivileged this is a no-op.
 */
const RUN_AS_POSTGRES = process.getuid?.() === 0;
function pgShellPrefix(): string {
  return RUN_AS_POSTGRES ? "sudo -n -u postgres -E " : "";
}

const PG_BIN_CANDIDATES = [
  "/usr/lib/postgresql/16/bin",
  "/usr/lib/postgresql/15/bin",
  "/usr/lib/postgresql/14/bin",
  "/opt/homebrew/opt/postgresql@16/bin",
  "/usr/local/opt/postgresql@16/bin",
];

export interface TempPostgresHandle {
  /** Absolute path of the Postgres data directory. */
  dataDir: string;
  /** TCP port the cluster is listening on. */
  port: number;
  /** Connection string ready to drop into `DATABASE_URL` / `DATABASE_URL_UNPOOLED`. */
  url: string;
}

function resolvePgBin(): string {
  for (const dir of PG_BIN_CANDIDATES) {
    if (existsSync(path.join(dir, "initdb"))) return dir;
  }
  throw new Error(
    `Could not find a Postgres install. Tried: ${PG_BIN_CANDIDATES.join(", ")}. ` +
      "Install postgresql-16 (apt-get install postgresql-16) and re-run.",
  );
}

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
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

/**
 * Start a fresh Postgres cluster, create the `test` database, and return a
 * handle the caller stops in teardown.
 *
 * Side effects (the trap):
 *   - Creates a temp data dir under the OS tempdir.
 *   - Binds to a 127.0.0.1 port (selected dynamically; never collides with
 *     concurrent runs).
 *   - Launches `postgres` as a child process. We DO NOT detach — when the test
 *     runner exits abruptly the OS reaps it.
 */
export async function startTempPostgres(): Promise<TempPostgresHandle> {
  const bin = resolvePgBin();
  const dataDir = await mkdtemp(path.join(tmpdir(), "ai-bus-e2e-pg-"));
  const port = await pickFreePort();
  const user = "postgres";
  const dbName = "test";

  // When running as root we delegate to the system `postgres` user. That
  // implies the data dir must be owned by `postgres` so `initdb` can tighten
  // its perms. We `chown` the empty dir, leave the rest to pg.
  if (RUN_AS_POSTGRES) {
    chmodSync(dataDir, 0o755);
    await exec(`chown postgres:postgres "${dataDir}"`);
  }

  // `initdb` — no auth, trust local connections via the unix socket / 127.0.0.1.
  // `--no-sync` makes init significantly faster at the cost of crash-safety
  // (irrelevant for an ephemeral test cluster).
  await exec(
    [
      `${pgShellPrefix()}"${path.join(bin, "initdb")}"`,
      `-D "${dataDir}"`,
      `-U ${user}`,
      `--auth=trust`,
      `--no-sync`,
      `--encoding=UTF8`,
    ].join(" "),
    { env: { ...process.env, LC_ALL: "C", PG_COLOR: "never" } },
  );

  // Postgres-side config: bind to localhost, fixed port, disable autovacuum
  // to keep CPU quiet during the spec, fsync off for speed.
  const overrides = [
    `listen_addresses = '127.0.0.1'`,
    `port = ${port}`,
    `unix_socket_directories = '${dataDir}'`,
    `fsync = off`,
    `synchronous_commit = off`,
    `full_page_writes = off`,
    `autovacuum = off`,
    `max_connections = 50`,
    `shared_buffers = 32MB`,
    `log_min_messages = warning`,
  ].join("\n");
  await appendFile(path.join(dataDir, "postgresql.conf"), `\n# e2e overrides\n${overrides}\n`);

  // Start it. `pg_ctl start -w` blocks until the server is ready (or fails).
  await exec(
    [
      `${pgShellPrefix()}"${path.join(bin, "pg_ctl")}"`,
      `-D "${dataDir}"`,
      `-l "${path.join(dataDir, "server.log")}"`,
      `-o "-p ${port}"`,
      `-w`,
      `-t 30`,
      `start`,
    ].join(" "),
    { env: { ...process.env, LC_ALL: "C", PG_COLOR: "never" } },
  );

  // Create the application database (initdb only made `postgres` + `template*`).
  await exec(
    `${pgShellPrefix()}"${path.join(bin, "createdb")}" -h 127.0.0.1 -p ${port} -U ${user} ${dbName}`,
    { env: { ...process.env, LC_ALL: "C" } },
  );

  const url = `postgresql://${user}@127.0.0.1:${port}/${dbName}?sslmode=disable`;
  return { dataDir, port, url };
}

/**
 * Stop the cluster and remove its data dir. Safe to call even if startup
 * partially failed.
 */
export async function stopTempPostgres(handle: TempPostgresHandle): Promise<void> {
  try {
    const bin = resolvePgBin();
    await exec(
      `${pgShellPrefix()}"${path.join(bin, "pg_ctl")}" -D "${handle.dataDir}" -m immediate -w -t 10 stop`,
      { env: { ...process.env, LC_ALL: "C" } },
    );
  } catch {
    // pg_ctl returns non-zero if the server is already down; that's fine.
  }
  try {
    await rm(handle.dataDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Apply the project's Drizzle migrations against the temp cluster.
 *
 * We shell out to `tsx src/db/migrate.ts` rather than calling drizzle's migrate
 * function directly, so any future changes to how migrations are applied
 * (e.g. transactional wrapping, extension setup) flow through one entry point.
 */
export async function migrateTempPostgres(url: string): Promise<void> {
  const proc = spawn("pnpm", ["exec", "tsx", "src/db/migrate.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      DATABASE_URL_UNPOOLED: url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number>((resolve) => {
    proc.on("close", (c) => resolve(c ?? 0));
  });
  if (code !== 0) {
    throw new Error(`db:migrate exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}
