#!/usr/bin/env tsx
/**
 * Support-staff CLI for the Deletion Request workflow (slice 15, ADR-0006).
 *
 * Usage:
 *   pnpm deletion-request --business-id <uuid> --reviewer-name "Jane D"
 *   pnpm deletion-request --business-id <uuid> --review-ids "g-1,g-2,g-3"
 *
 * Optional:
 *   --base-url http://localhost:3000     (default — for local dev)
 *   --base-url https://app.example.com   (for production runs)
 *
 * Authentication: this script sends `X-Internal-Admin-Key: <INTERNAL_ADMIN_KEY>`
 * pulled from the env. Set it in your local `.env` or export it before
 * invoking. The endpoint also accepts an admin Clerk session, but the CLI
 * uses the header path so we don't need a browser-style session here.
 *
 * The script ALWAYS prompts for `Type YES to continue:` confirmation before
 * mutating data. The runbook (`docs/runbooks/deletion-request.md`) is the
 * single source of truth on when and how to invoke this — this script is
 * deliberately a thin wrapper so the runbook stays in charge of policy.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

interface CliArgs {
  businessId: string;
  reviewerName?: string;
  reviewIds?: string[];
  baseUrl: string;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      "business-id": { type: "string" },
      "reviewer-name": { type: "string" },
      "review-ids": { type: "string" },
      "base-url": { type: "string", default: "http://localhost:3000" },
    },
    allowPositionals: false,
  });

  const businessId = values["business-id"];
  if (!businessId) {
    bail("Missing required --business-id");
  }
  const reviewerName = values["reviewer-name"];
  const reviewIdsRaw = values["review-ids"];

  if (Boolean(reviewerName) === Boolean(reviewIdsRaw)) {
    bail("Provide EXACTLY ONE of --reviewer-name or --review-ids (not both, not neither)");
  }

  const reviewIds = reviewIdsRaw
    ? reviewIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;
  if (reviewIds && reviewIds.length === 0) {
    bail("--review-ids was provided but parsed to an empty list");
  }

  return {
    businessId: businessId as string,
    reviewerName,
    reviewIds,
    baseUrl: values["base-url"] as string,
  };
}

function bail(message: string): never {
  console.error(`Error: ${message}`);
  console.error("Usage:");
  console.error(
    '  pnpm deletion-request --business-id <uuid> (--reviewer-name "Jane D" | --review-ids "g-1,g-2")',
  );
  console.error("  Optional: --base-url <url>  (default http://localhost:3000)");
  process.exit(2);
}

async function confirm(args: CliArgs): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    console.log("");
    console.log("About to honour a Deletion Request:");
    console.log(`  business_id : ${args.businessId}`);
    if (args.reviewerName) {
      console.log(`  reviewer    : "${args.reviewerName}"`);
    } else {
      console.log(`  review_ids  : ${(args.reviewIds ?? []).join(", ")}`);
    }
    console.log(`  target      : ${args.baseUrl}`);
    console.log("");
    console.log(
      "This will NULL `review_text` and `reviewer_display_name` on the matching Reviews.",
    );
    console.log("Classifications stay intact (trend reporting is preserved).");
    console.log("This action cannot be undone.");
    console.log("");
    const answer = await rl.question("Type YES to continue: ");
    return answer.trim() === "YES";
  } finally {
    rl.close();
  }
}

interface EndpointResponse {
  affected: number;
  business_id: string;
  matched_review_ids: string[];
}

async function invokeEndpoint(args: CliArgs, adminKey: string): Promise<EndpointResponse> {
  const url = `${args.baseUrl.replace(/\/+$/, "")}/api/internal/deletion-request`;
  const body: Record<string, unknown> = { business_id: args.businessId };
  if (args.reviewerName) body.reviewer_display_name = args.reviewerName;
  if (args.reviewIds) body.source_review_ids = args.reviewIds;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-admin-key": adminKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text();
    }
    throw new Error(`HTTP ${res.status} from ${url}: ${detail}`);
  }
  return (await res.json()) as EndpointResponse;
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  const adminKey = process.env.INTERNAL_ADMIN_KEY;
  if (!adminKey || adminKey.length === 0) {
    bail(
      "INTERNAL_ADMIN_KEY must be set in env. See .env.example and the deletion-request runbook.",
    );
  }

  const ok = await confirm(args);
  if (!ok) {
    console.log("Aborted (no rows touched).");
    process.exit(1);
  }

  const result = await invokeEndpoint(args, adminKey);
  console.log("");
  console.log(`Affected rows: ${result.affected}`);
  console.log(`Business      : ${result.business_id}`);
  console.log("Matched review IDs:");
  if (result.matched_review_ids.length === 0) {
    console.log("  (none — verify the inputs against the support ticket)");
  } else {
    for (const id of result.matched_review_ids) {
      console.log(`  ${id}`);
    }
  }
  console.log("");
  console.log("Paste the above IDs into the support ticket as the audit record.");
}

main().catch((err) => {
  console.error("");
  console.error("deletion-request failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
