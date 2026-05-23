# evals.json format

Reference for the behavioural-eval JSON schema (Layer 2 of evaluate-skill). One `evals.json` per skill, sitting next to `SKILL.md`.

## Schema

```jsonc
{
  "skill_name": "<must match SKILL.md frontmatter name>",
  "evals": [
    {
      "id": "<unique-slug>",
      "prompt": "<exact user message to feed the agent>",
      "expected_output": "<one-sentence human description of success>",
      "files": ["<optional path>", "..."],   // input fixtures the skill needs
      "assertions": [
        "<natural-language statement that must hold>",
        "..."
      ]
    }
  ]
}
```

## Field rules

- **`skill_name`** — must equal the `name:` in `SKILL.md` frontmatter. Mismatches mean the eval will run against the wrong skill.
- **`id`** — short slug, unique per file. Used in failure reports.
- **`prompt`** — the literal text the user would type. Don't paraphrase. Don't include hidden setup; put that in `files` or a `before` script.
- **`expected_output`** — for humans reading the file later. The grader doesn't enforce this; `assertions` do.
- **`files`** — paths to fixtures the skill needs (e.g. a sample SKILL.md to validate). Copied into the test scratch dir before the prompt runs.
- **`assertions`** — atomic, testable, **single-fact** statements. Split conjunctions ("A and B") into two assertions.

## Assertion style

**Good** (atomic, evidence-anchored):
- `The agent ran scripts/validate-skill.sh`
- `The output contained the string "FAIL"` 
- `The agent did not write to any file outside .claude/skills/`
- `The response is under 200 words`

**Bad** (compound, vague, judgement-laden):
- `The agent did the right thing` — what is "right"?
- `The output was helpful and accurate` — two assertions in one, both vague
- `The agent demonstrated understanding` — unmeasurable

## Mechanical vs behavioural assertions

When grading, split assertions into two buckets:

- **Mechanical** (verifiable with code): file exists, exit code is 0, output contains substring, JSON parses, command was invoked. Use a script — never an LLM.
- **Behavioural** (require reading the transcript): asked a clarifying question, didn't add unrelated cleanup, summarised concisely. Use an LLM judge with the assertion as the rubric.

Tag each assertion in your grader so you don't accidentally pay an LLM to grep for a substring.

## Minimum viable evals.json

Even one happy-path case beats zero. Start with:

```json
{
  "skill_name": "your-skill",
  "evals": [
    {
      "id": "happy-path",
      "prompt": "<the most obvious way a user would invoke this skill>",
      "expected_output": "<what success looks like>",
      "assertions": ["<the single most important thing the skill must do>"]
    }
  ]
}
```

Grow from there as bugs surface.

## Output file from a grading run

Store grading results alongside `evals.json` as `evals-results-<timestamp>.json`:

```json
{
  "skill_name": "evaluate-skill",
  "timestamp": "2026-05-23T10:00:00Z",
  "results": [
    {
      "id": "happy-path",
      "assertions": [
        {"text": "...", "kind": "mechanical", "verdict": "PASS", "evidence": "exit code 0"},
        {"text": "...", "kind": "behavioural", "verdict": "FAIL", "evidence": "agent never invoked the script"}
      ]
    }
  ]
}
```

This lets you diff runs across skill revisions.
