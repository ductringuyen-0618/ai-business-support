/**
 * Classifier eval runner.
 *
 * Reads `evals.json`, calls `classify()` for every case, grades the mechanical
 * assertions in-process, and writes `benchmark.json` next to `evals.json`.
 * Behavioural assertions are tagged but not scored here — they're flagged for
 * later review (e.g. via the `evaluate-skill` LLM-judge step).
 *
 * Modes:
 *   - Default (no `ANTHROPIC_API_KEY` set): runs in dry-run mode against the
 *     recorded fixtures in `__fixtures__/anthropic/`, so a baseline can be
 *     produced on CI without spending tokens. This is what we ship as the v1
 *     `benchmark.json`.
 *   - With `ANTHROPIC_API_KEY=...`: calls the real Anthropic API.
 *
 * Re-run after any prompt change (see ../README.md). The diff in
 * `benchmark.json` is the PR's evidence.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classify, type Classification } from "..";
import type { AnthropicCreateResponse, AnthropicMessageClient } from "../anthropic-client";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVALS_PATH = join(HERE, "evals.json");
const BENCHMARK_PATH = join(HERE, "benchmark.json");
const FIXTURE_DIR = join(HERE, "..", "__fixtures__", "anthropic");

interface Assertion {
  type: "mechanical" | "behavioural";
  id: string;
  description: string;
}

interface EvalCase {
  id: string;
  prompt: string;
  input: {
    starRating: number;
    postedAt: string;
    businessProfile: { name: string; industry?: string };
  };
  expected_output: string;
  assertions: Assertion[];
}

interface EvalsFile {
  skill_name: string;
  prompt_version: string;
  description: string;
  evals: EvalCase[];
}

interface CaseResult {
  id: string;
  passed: boolean;
  classification: Classification | null;
  error: string | null;
  assertions: Array<{
    id: string;
    type: "mechanical" | "behavioural";
    description: string;
    passed: boolean | null; // null = not scored (behavioural)
    note?: string;
  }>;
  latencyMs: number;
}

interface Benchmark {
  skill_name: string;
  prompt_version: string;
  generated_at: string;
  mode: "fixture" | "live";
  summary: {
    cases: number;
    passed: number;
    failed: number;
    pass_rate: number;
    mechanical_assertions: number;
    mechanical_passed: number;
    behavioural_assertions: number;
  };
  results: CaseResult[];
}

/**
 * Map each eval `id` to a recorded Anthropic response file. Used in fixture
 * mode. New eval cases without a fixture run with a synthetic "minimal valid"
 * response so the benchmark still has a row for them.
 */
const FIXTURE_BY_EVAL_ID: Record<string, string> = {
  "positive-5-star": "positive-5-star.json",
  "mild-negative-2-star": "mild-negative-2-star.json",
  "four-star-slur": "four-star-slur.json",
  "food-safety": "food-safety.json",
  "ambulance-medical-emergency": "ambulance.json",
  sarcasm: "sarcasm.json",
  "non-english-spanish": "non-english-spanish.json",
};

/**
 * Synthetic responses for the two edge cases that don't have a hand-recorded
 * fixture. Kept here (not as files) so it's obvious they're synthetic and not
 * a real LLM trace.
 */
const SYNTHETIC_RESPONSES: Record<string, AnthropicCreateResponse> = {
  "edge-empty-text": {
    content: [
      {
        type: "text",
        text: '<output>{"is_incident": false, "severity": null, "themes": ["other"], "sentiment": "neutral", "suggested_reply": "Thank you for the rating! If there is anything we can do better, please let us know."}</output>',
      },
    ],
    stop_reason: "end_turn",
  },
  "edge-accessibility-soft-complaint": {
    content: [
      {
        type: "text",
        text: '<output>{"is_incident": true, "severity": "medium", "themes": ["accessibility", "staff_attitude"], "sentiment": "negative", "suggested_reply": "Thank you for telling us — service animals are absolutely welcome and the response you describe is not acceptable. We will retrain the team on accessibility and would love the chance to make this right next time you stop in."}</output>',
      },
    ],
    stop_reason: "end_turn",
  },
};

function fixtureClient(): AnthropicMessageClient {
  let currentCaseId: string | null = null;
  return {
    create: async () => {
      if (!currentCaseId) throw new Error("fixtureClient: case id not set");
      const fname = FIXTURE_BY_EVAL_ID[currentCaseId];
      if (fname) {
        const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, fname), "utf8"));
        return raw as AnthropicCreateResponse;
      }
      const synth = SYNTHETIC_RESPONSES[currentCaseId];
      if (synth) return synth;
      throw new Error(`fixtureClient: no fixture or synthetic for ${currentCaseId}`);
    },
    _setCaseId(id: string) {
      currentCaseId = id;
    },
  } as AnthropicMessageClient & { _setCaseId: (id: string) => void };
}

function gradeMechanical(
  assertion: Assertion,
  classification: Classification,
): { passed: boolean; note?: string } {
  switch (assertion.id) {
    case "is_incident_true":
      return { passed: classification.is_incident === true };
    case "is_incident_false":
      return { passed: classification.is_incident === false };
    case "severity_null":
      return { passed: classification.severity === null };
    case "severity_high":
      return { passed: classification.severity === "high" };
    case "severity_set":
      return {
        passed:
          classification.severity === "low" ||
          classification.severity === "medium" ||
          classification.severity === "high",
      };
    case "sentiment_positive":
      return { passed: classification.sentiment === "positive" };
    case "sentiment_negative":
      return { passed: classification.sentiment === "negative" };
    case "theme_wait_time":
      return { passed: classification.themes.includes("wait_time") };
    case "theme_staff_attitude":
      return { passed: classification.themes.includes("staff_attitude") };
    case "theme_accessibility":
      return { passed: classification.themes.includes("accessibility") };
    case "theme_overlap_service_or_product":
      return {
        passed:
          classification.themes.includes("service") ||
          classification.themes.includes("product_quality"),
      };
    case "theme_safety_overlap":
      return {
        passed:
          classification.themes.includes("cleanliness") ||
          classification.themes.includes("product_quality"),
      };
    case "theme_overlap_emergency":
      return {
        passed:
          classification.themes.includes("staff_attitude") ||
          classification.themes.includes("accessibility") ||
          classification.themes.includes("service"),
      };
    case "themes_non_empty":
      return { passed: classification.themes.length > 0 };
    case "reply_under_500":
      return {
        passed:
          classification.suggested_reply.length >= 1 &&
          classification.suggested_reply.length <= 500,
      };
    default:
      return { passed: false, note: `unknown mechanical assertion id "${assertion.id}"` };
  }
}

async function runOne(
  evalCase: EvalCase,
  client: AnthropicMessageClient,
  mode: "fixture" | "live",
): Promise<CaseResult> {
  if (mode === "fixture") {
    (client as unknown as { _setCaseId: (id: string) => void })._setCaseId(evalCase.id);
  }

  const start = Date.now();
  let classification: Classification | null = null;
  let error: string | null = null;
  try {
    classification = await classify(
      {
        redactedText: evalCase.prompt,
        starRating: evalCase.input.starRating,
        postedAt: evalCase.input.postedAt,
        businessProfile: evalCase.input.businessProfile,
      },
      { client },
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const latencyMs = Date.now() - start;

  const assertionResults = evalCase.assertions.map((a) => {
    if (a.type === "behavioural") {
      return {
        id: a.id,
        type: a.type,
        description: a.description,
        passed: null,
        note: "deferred to LLM-judge or human review",
      };
    }
    if (!classification) {
      return {
        id: a.id,
        type: a.type,
        description: a.description,
        passed: false,
        note: "classify() threw",
      };
    }
    const { passed, note } = gradeMechanical(a, classification);
    return { id: a.id, type: a.type, description: a.description, passed, note };
  });

  const mechanical = assertionResults.filter((r) => r.type === "mechanical");
  const allMechanicalPassed = mechanical.every((r) => r.passed === true);

  return {
    id: evalCase.id,
    passed: allMechanicalPassed && error === null,
    classification,
    error,
    assertions: assertionResults,
    latencyMs,
  };
}

async function main() {
  const evalsFile = JSON.parse(readFileSync(EVALS_PATH, "utf8")) as EvalsFile;
  const live = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.EVALS_LIVE === "1";
  const mode: "fixture" | "live" = live ? "live" : "fixture";

  const client = mode === "fixture" ? fixtureClient() : undefined;

  const results: CaseResult[] = [];
  for (const c of evalsFile.evals) {
    // In live mode we let `classify()` build its own default SDK client.
    const r = await runOne(c, client as AnthropicMessageClient, mode);
    results.push(r);
  }

  const mechanicalAssertions = results
    .flatMap((r) => r.assertions)
    .filter((a) => a.type === "mechanical");
  const behaviouralAssertions = results
    .flatMap((r) => r.assertions)
    .filter((a) => a.type === "behavioural");
  const summary = {
    cases: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    pass_rate: Number((results.filter((r) => r.passed).length / results.length).toFixed(4)),
    mechanical_assertions: mechanicalAssertions.length,
    mechanical_passed: mechanicalAssertions.filter((a) => a.passed === true).length,
    behavioural_assertions: behaviouralAssertions.length,
  };

  const benchmark: Benchmark = {
    skill_name: evalsFile.skill_name,
    prompt_version: evalsFile.prompt_version,
    generated_at: new Date().toISOString(),
    mode,
    summary,
    results,
  };

  writeFileSync(BENCHMARK_PATH, `${JSON.stringify(benchmark, null, 2)}\n`, "utf8");
  console.log(
    `[evals:classifier] mode=${mode} cases=${summary.cases} passed=${summary.passed} ` +
      `failed=${summary.failed} pass_rate=${summary.pass_rate} ` +
      `mechanical=${summary.mechanical_passed}/${summary.mechanical_assertions}`,
  );
  if (summary.failed > 0 && mode === "live") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
