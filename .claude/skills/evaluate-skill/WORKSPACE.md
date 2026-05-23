# Eval workspace layout & JSON schemas

The canonical directory structure for an evaluation workspace, plus the schemas for `timing.json`, `grading.json`, `benchmark.json`, and `feedback.json`. Used by Layer 2 of [evaluate-skill](./SKILL.md).

## Directory layout

```
<skill-name>/
├── SKILL.md
└── evals/
    ├── evals.json            # authored by hand
    └── files/                # input fixtures referenced by `files:` in evals.json
        └── sales_2025.csv

<skill-name>-workspace/        # sibling to the skill dir, NOT inside it
├── skill-snapshot/            # optional: copy of previous skill version, used as baseline when iterating
└── iteration-1/
    ├── eval-<id-or-slug>/
    │   ├── with_skill/
    │   │   ├── outputs/       # whatever files the run produced
    │   │   ├── timing.json
    │   │   └── grading.json
    │   └── without_skill/     # or `old_skill/` when comparing against a snapshot
    │       ├── outputs/
    │       ├── timing.json
    │       └── grading.json
    ├── eval-<id>/...
    ├── benchmark.json         # aggregated across all evals in this iteration
    └── feedback.json          # human review notes, one entry per eval
└── iteration-2/...
```

**Rule of thumb:** authored by hand → `evals/evals.json`. Everything else → produced by runs, scripts, or the human reviewer.

## timing.json

Captured per run, immediately after the run completes.

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332
}
```

In Claude Code, these come from the subagent task-completion notification (`total_tokens`, `duration_ms`). They are not persisted anywhere else — write them as soon as the run returns.

## grading.json

Captured per run, after assertions are evaluated against `outputs/`.

```json
{
  "assertion_results": [
    {
      "text": "The output includes a bar chart image file",
      "passed": true,
      "evidence": "Found chart.png (45KB) in outputs directory"
    },
    {
      "text": "Both axes are labeled",
      "passed": false,
      "evidence": "Y-axis is labeled 'Revenue ($)' but X-axis has no label"
    }
  ],
  "summary": {
    "passed": 3,
    "failed": 1,
    "total": 4,
    "pass_rate": 0.75
  }
}
```

**Evidence is mandatory.** "Passed: true" without evidence is uninspectable. Quote or reference the output.

## benchmark.json

One per iteration, aggregating across all evals.

```json
{
  "run_summary": {
    "with_skill": {
      "pass_rate":    {"mean": 0.83, "stddev": 0.06},
      "time_seconds": {"mean": 45.0, "stddev": 12.0},
      "tokens":       {"mean": 3800, "stddev": 400}
    },
    "without_skill": {
      "pass_rate":    {"mean": 0.33, "stddev": 0.10},
      "time_seconds": {"mean": 32.0, "stddev": 8.0},
      "tokens":       {"mean": 2100, "stddev": 300}
    },
    "delta": {
      "pass_rate":    0.50,
      "time_seconds": 13.0,
      "tokens":       1700
    }
  }
}
```

The **delta** block is the verdict:
- +50pp pass rate for +13s and +1700 tokens → **ship it**
- +2pp pass rate for +200% tokens → **don't**

Stddev is only meaningful with multiple runs per eval. In early iterations (single run × few cases), focus on raw counts and the delta.

## feedback.json

One per iteration. Authored by a human reviewer after looking at outputs alongside grades.

```json
{
  "eval-top-months-chart": "The chart is missing axis labels and the months are in alphabetical order instead of chronological.",
  "eval-clean-missing-emails": ""
}
```

Empty string = output looked fine, no complaints.  
Actionable specifics > vague impressions ("missing axis labels" beats "looks bad").

## The iteration loop

```
authored once:  evals/evals.json (prompts + expected outputs only)

per iteration:
  1. spawn paired runs    → outputs/, timing.json
  2. grade assertions     → grading.json
  3. aggregate            → benchmark.json
  4. human review         → feedback.json
  5. feed (assertions + transcripts + feedback + SKILL.md) to an LLM
  6. apply proposed SKILL.md changes
  7. start iteration-<N+1>/ and go to 1

stop when:
  - feedback.json entries are consistently empty, OR
  - delta between consecutive iterations is no longer meaningful, OR
  - you're satisfied
```

After step 1 of the **first** iteration, pause and write the `assertions` for each eval based on what the outputs actually look like. Subsequent iterations reuse and refine those assertions.
