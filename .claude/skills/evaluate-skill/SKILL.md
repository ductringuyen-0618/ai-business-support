---
name: evaluate-skill
description: Evaluate whether an agent skill is well-formed and actually works. Combines mechanical spec/quality checks (via scripts/validate-skill.sh) with behavioral evals (run the skill on test prompts, grade with assertions) and holistic LLM-as-judge scoring (JUDGE-RUBRIC.md). Use when the user wants to verify a skill, evaluate skill quality, audit a skill, write evals for a skill, compare two versions of a skill (blind A/B), or after creating a new skill via write-a-skill. Also use proactively after installing a third-party skill bundle to catch broken or low-quality skills before relying on them.
---

# Evaluate a skill

Three layers of evaluation. Run them in order — cheap checks first, expensive ones last.

## Layer 1 — Mechanical (script)

Run `scripts/validate-skill.sh <path-to-skill-dir>` (or `--all` to walk every skill under `.claude/skills/`). It enforces the AgentSkills spec and prints structured PASS / WARN / FAIL output. Exit codes: `0` clean, `1` errors, `2` warnings only.

The script checks:

- `SKILL.md` exists
- YAML frontmatter at the top with valid `name` (lowercase alphanumeric + hyphens, 1–64 chars) and non-empty `description`
- Description ≤ 1024 chars and includes a "Use when" trigger phrase
- SKILL.md body ≤ ~100 lines (warn) / ~250 lines (error) — push extras into sibling reference files
- Sibling files referenced from SKILL.md actually exist (no broken relative links)
- Files in `scripts/`, `references/`, `assets/` are referenced from SKILL.md (no orphans)
- Imperative ratio (rough proxy: fraction of bullet lines starting with an imperative verb)

Fix everything FAIL-level before moving on. WARN-level is a judgement call.

## Layer 2 — Behavioural evals

Mechanical checks tell you the skill is well-formed. They don't tell you it *works*. For that, write an `evals.json` next to the skill:

```json
{
  "skill_name": "evaluate-skill",
  "evals": [
    {
      "id": "basic-invoke",
      "prompt": "Verify the diagnose skill",
      "expected_output": "Runs validate-skill.sh on .claude/skills/diagnose and reports findings",
      "assertions": [
        "The agent invoked scripts/validate-skill.sh",
        "The output contains PASS/WARN/FAIL lines for the diagnose skill",
        "The agent did not modify any files"
      ]
    }
  ]
}
```

See [EVALS-FORMAT.md](./EVALS-FORMAT.md) for the full schema.

**Run each eval:** start a fresh session (no carryover context), feed the `prompt`, capture the full transcript.

**Grade each assertion:**

- **Mechanical assertions** (file exists, exit code, output contains string, JSON parses, command was invoked): verify with code, not with an LLM. Scripts beat judgment for binary checks.
- **Behavioural assertions** ("the agent asked a clarifying question before writing", "the response was concise"): give the transcript + assertions to an LLM judge and have it return PASS / FAIL with one-sentence evidence per assertion.

Record results so you can diff them across skill revisions.

## Layer 3 — Holistic LLM-as-judge (when iterating)

Layers 1 and 2 catch correctness. They miss things like "the new version is technically correct but harder to read." Use this when you're changing a skill and want to confirm you haven't regressed on polish.

See [JUDGE-RUBRIC.md](./JUDGE-RUBRIC.md) for the rubric (organization, clarity, actionability, token efficiency, scope discipline).

**Blind comparison protocol** — critical:

1. Run the same eval prompt against version A and version B of the skill, separately.
2. Capture both transcripts.
3. Randomly assign them as "Output 1" and "Output 2" (don't label which is which).
4. Pass both to an LLM judge along with the rubric. Ask it to score each on every dimension and pick a winner per dimension.
5. Only after the judge returns scores, reveal which version was which.

This removes bias toward "the version I just spent effort on must be better."

## When you get blocked

- **Network blocks** (can't fetch a spec page): use cached copies, the GitHub source, or related implementations (e.g. `agent-ecosystem/skill-validator`). If still blocked, work from the parts of the spec you already have — partial coverage of a real skill beats waiting on a perfect spec.
- **Skill has no tests yet**: write the *minimum viable* eval — one happy-path case — and run it. Iterate from there.
- **Can't run the skill in isolation** (depends on repo state): create a throwaway scratch dir with the minimum fixtures, run there.
- **Judge model disagrees with you**: re-read the rubric. If the judge is wrong, sharpen the rubric. If you're wrong, accept the finding.

## Output format

When reporting findings, structure them as:

```
Skill: <name>
  Layer 1 (mechanical): PASS | WARN (n) | FAIL (n)
    - [WARN] description missing "Use when" trigger
    - [FAIL] orphan file references/foo.md
  Layer 2 (behavioural): n/m evals passed
    - [eval-id] FAIL — assertion "..." failed because ...
  Layer 3 (judge): only when comparing versions
```

Keep the report scannable. Don't bury the lede.
