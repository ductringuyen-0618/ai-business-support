---
name: evaluate-skill
description: Evaluate whether an agent skill is well-formed AND actually improves outputs over no skill (or over a previous version). Combines mechanical spec/quality checks (scripts/validate-skill.sh) with eval-driven iteration that runs each test case with-skill vs without-skill, grades assertions, aggregates pass-rate/time/token deltas in benchmark.json, and feeds results back into a skill-improvement loop. Use when the user wants to verify a skill, audit a skill, write evals for a skill, prove a skill adds value, compare two skill versions (blind A/B), benchmark a skill, or iterate to improve a skill. Also use proactively after creating a skill (via write-a-skill) or after installing a third-party skill bundle. Follows the canonical agentskills.io methodology.
---

# Evaluate a skill

Three layers — run them cheapest first.

## Layer 1 — Mechanical (script, always run first)

`scripts/validate-skill.sh <skill-dir>` (or `--all` to walk `.claude/skills/`). Enforces the AgentSkills spec: frontmatter validity, description length & "Use when" trigger, body line budgets, broken refs, orphan files in `scripts/`/`references/`/`assets/`. Exit `0` clean, `1` errors, `2` warnings.

Fix every FAIL before moving on. WARNs are judgement calls.

## Layer 2 — Eval-driven iteration (the real work)

Mechanical validity ≠ usefulness. The **only** way to know a skill helps is to run the same prompts with-skill vs without-skill (or vs a previous version) and measure the delta. See [WORKSPACE.md](./WORKSPACE.md) for the full directory layout and JSON schemas. See [EVALS-FORMAT.md](./EVALS-FORMAT.md) for the `evals.json` schema.

### Step 1 — Author test cases (prompts only, no assertions yet)

Write `<skill>/evals/evals.json` with 2–3 cases. Each case has a `prompt`, an `expected_output` (human-readable), and optional `files`. **Do not write assertions yet** — you don't know what "good" looks like until the skill has actually run.

Prompt-writing rules:
- Vary phrasing (casual vs precise), detail level, formality
- Include at least one edge case (malformed input, ambiguous request)
- Use realistic context (real paths, real column names) — "process this data" tests nothing
- Stop at 2–3. Expand after the first round of results.

### Step 2 — Spawn paired runs (with-skill AND without-skill)

For each test case, run **twice from clean context**: once with the skill loaded, once without. Save outputs into the workspace layout:

```
<skill>-workspace/iteration-1/eval-<id>/
├── with_skill/{outputs/,timing.json,grading.json}
└── without_skill/{outputs/,timing.json,grading.json}
```

When iterating on an existing skill, snapshot the previous version (`cp -r <skill> <workspace>/skill-snapshot/`) and use it as the baseline. Save to `old_skill/` instead of `without_skill/`.

Capture `total_tokens` and `duration_ms` per run into `timing.json`. In Claude Code these come from the subagent task-completion notification; capture them immediately because nothing else persists them.

Always start each run with **clean context** (subagent or new session). Carryover from skill development poisons results.

### Step 3 — Write assertions (now that you've seen outputs)

Add `assertions` to each case in `evals.json`. Atomic, observable, evidence-anchorable:

- ✅ `"The output file is valid JSON"` — code-checkable
- ✅ `"The bar chart has labeled axes"` — observable
- ✅ `"The report includes at least 3 recommendations"` — countable
- ❌ `"The output is good"` — vague
- ❌ `"Uses exactly the phrase 'Total Revenue: $X'"` — brittle

Not everything needs an assertion. Style, polish, "feel" go to human review (Step 5) or the blind judge (Layer 3).

### Step 4 — Grade

Per run, write `grading.json` with PASS/FAIL + **evidence** for each assertion (quote or reference the output, not opinions).

- **Mechanical assertions** (file exists, JSON parses, row count): use code/scripts. Never burn an LLM on a substring match.
- **Behavioural assertions** ("chart has labels"): LLM judge with the assertion as rubric, evidence required.

**Grading discipline:**
- Require concrete evidence for PASS. A section titled "Summary" with one vague sentence is **FAIL**, not "benefit of the doubt".
- While grading, flag assertions that are too easy (always pass), too hard (always fail), or unverifiable. Fix them before the next iteration.

### Step 5 — Aggregate, analyze, review

Aggregate the iteration into `<workspace>/iteration-N/benchmark.json` with mean/stddev of pass_rate, time, tokens for both configurations and a `delta` block. The delta is the verdict: a skill that adds 13s but +50pp pass-rate is worth it; one that doubles tokens for +2pp is not.

Five post-grading patterns to look for:

1. **Always-pass in both configs** → remove the assertion (inflates with-skill score without measuring anything)
2. **Always-fail in both configs** → assertion is broken or task is too hard. Fix it.
3. **Pass with skill, fail without** → here's where the skill earns its keep. Understand *why* — which instruction or script made the difference?
4. **High stddev across runs** → eval is flaky OR skill instructions are ambiguous. Sharpen them.
5. **Time/token outliers** → read the execution transcript, find the bottleneck.

Then do **human review** — assertions only catch what you thought to write. Save specific complaints to `feedback.json` ("Chart is missing axis labels, months in alphabetical order instead of chronological"). Empty string = looked fine.

### Step 6 — Iterate

Feed an LLM the three signals + the current `SKILL.md` and ask for proposed changes:
- Failed assertions (specific gaps)
- Human feedback (broader quality)
- Execution transcripts (root cause)

Prompt guidelines for the proposer:
- **Generalise** — the skill runs across many prompts, not just these. Fix root causes, don't add narrow patches.
- **Keep it lean** — fewer, better instructions usually beat exhaustive rules. If pass-rate plateaus while adding rules, you're over-constraining; try removing.
- **Explain the why** — "Do X because Y causes Z" beats "ALWAYS X, NEVER Y".
- **Bundle repeated work** — if every run wrote a similar helper, promote it into `scripts/`.

Review, apply, re-run in a fresh `iteration-<N+1>/` directory. Stop when feedback is consistently empty or improvements plateau.

## Layer 3 — Blind LLM-as-judge (when comparing versions)

For polish/organization regressions that assertions miss. See [JUDGE-RUBRIC.md](./JUDGE-RUBRIC.md) — 5 dimensions, blind-A/B protocol, JSON judge output.

## When you get blocked

- **Network policy blocks a doc page** → try `raw.githubusercontent.com/<org>/<repo>/main/<path>` for any open-spec docs (this is how this skill itself was sourced). Last resort: ask the user to widen the network policy via [Claude Code on the web env settings](https://code.claude.com/docs/en/claude-code-on-the-web).
- **No subagent isolation available** → use a fresh terminal session per run. Carryover invalidates results.
- **Skill needs files that don't exist** → put fixtures under `<skill>/evals/files/` and reference them via the `files` array.
- **Judge picks the regression** → trust it. That's the point of blind comparison.

## Related

The [`skill-creator`](https://github.com/anthropics/skills/tree/main/skills/skill-creator) skill from `anthropic/skills` automates much of Layer 2 (spawning runs, grading, aggregating). Worth installing if you'll iterate on many skills.
