# evals.json format

Reference for the test-case JSON schema (Layer 2 of [evaluate-skill](./SKILL.md)). Authored by hand; everything else (`timing.json`, `grading.json`, `benchmark.json`, `feedback.json`) is produced by runs — see [WORKSPACE.md](./WORKSPACE.md).

## Location

```
<skill-name>/
├── SKILL.md
└── evals/
    ├── evals.json
    └── files/
        └── <fixture-files-referenced-by-cases>
```

`evals/` lives **inside** the skill directory. Workspace output (`<skill>-workspace/`) lives as a **sibling** so it's easy to gitignore.

## Schema

```jsonc
{
  "skill_name": "<must match SKILL.md frontmatter name>",
  "evals": [
    {
      "id": 1,
      "prompt": "<exact user message — don't paraphrase>",
      "expected_output": "<one-sentence human description of success>",
      "files": ["evals/files/sales_2025.csv"],
      "assertions": [
        "<atomic, observable statement — add AFTER first run>",
        "..."
      ]
    }
  ]
}
```

## Field rules

- **`skill_name`** — must equal `name:` in `SKILL.md` frontmatter. Mismatches mean evals run against the wrong skill.
- **`id`** — unique per file. Integer or short slug. Surfaces in failure reports and workspace directory names (`eval-<id>/` or `eval-<slug>/`).
- **`prompt`** — the literal text a user would type. Do not paraphrase. Do not embed hidden setup; put fixtures in `files`.
- **`expected_output`** — human description for readers of the file. The grader does **not** enforce this; `assertions` do.
- **`files`** — paths to fixtures the skill needs (sample CSVs, broken JSON, etc.). Relative to the skill directory. Copied into the run's scratch dir before the prompt fires.
- **`assertions`** — atomic statements you grade against. **Leave empty in the first iteration.** Add after you've seen what the skill actually produces.

## Prompt-writing rules

- **Start with 2–3 cases.** Don't over-invest before the first round of results.
- **Vary phrasing.** Casual ("hey can you clean up this csv"), precise ("Parse /data/input.csv, drop rows where col B is null, write /data/output.csv"). Different formality, different detail.
- **Cover edge cases.** At least one boundary condition — malformed input, ambiguous request, unusual format.
- **Use realistic context.** Real paths, real column names, real-sounding personal context. "Process this data" tests nothing.

## Assertion style (add after first run)

**Good** — atomic, observable, evidence-anchorable:
- `"The output file is valid JSON"` — code-checkable
- `"The bar chart has labeled axes"` — observable from the output
- `"The report includes at least 3 recommendations"` — countable
- `"The agent did not modify files outside outputs/"` — checkable from transcript

**Bad** — vague, compound, brittle:
- `"The output is good"` — what does "good" mean?
- `"The output is helpful AND accurate"` — two assertions; split them
- `"Uses exactly the phrase 'Total Revenue: $X'"` — correct output with different wording would fail
- `"The agent demonstrated understanding"` — unmeasurable

**Split conjunctions.** "Output is valid JSON and contains at least 3 keys" → two assertions.

## Mechanical vs behavioural assertions

When grading (see [WORKSPACE.md](./WORKSPACE.md) → `grading.json`), tag each assertion:

- **Mechanical** (code-checkable): file exists, exit code, output contains substring, JSON parses, row count, image dimensions. **Always use a script.** Never burn an LLM on a substring grep.
- **Behavioural** (requires reading the output/transcript): "chart has labeled axes", "agent asked a clarifying question first", "response is concise". Use an LLM judge with the assertion as the rubric, evidence mandatory.

Mis-tagging is the most common waste of eval tokens.

## Not everything needs an assertion

Style, polish, "feel right" are hard to decompose into pass/fail. Don't try. Route them to:
- **Human review** → `feedback.json` (see WORKSPACE.md)
- **Blind LLM-judge** → [JUDGE-RUBRIC.md](./JUDGE-RUBRIC.md), only when comparing two skill versions

Reserve assertions for what can be checked objectively.

## Minimum viable evals.json

Start with this. One happy-path case, no assertions yet.

```json
{
  "skill_name": "your-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "<the most obvious way a user would invoke this skill>",
      "expected_output": "<what success looks like, one sentence>"
    }
  ]
}
```

Run it once with-skill and once without-skill (see WORKSPACE.md). Look at the outputs. **Then** add assertions and grow the test set.
