# ai-business-support

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `ductringuyen-0618/ai-business-support`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical defaults (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Cross-session memory

Agents persist tacit knowledge across runs via the `dreams` skill (`.claude/skills/dreams/SKILL.md`). On startup, read everything under `.claude/agent-memory/`. On finish (PR or significant unit of work), write a brief structured entry there.

Start with `.claude/agent-memory/CONSOLIDATED-waves-0-2.md` — it captures the cross-cutting conventions from the first 9 slices (DI seams in handlers, repository pattern for queries, migration recipe, redaction chokepoint, vitest globs, etc.). Read it before writing code.
