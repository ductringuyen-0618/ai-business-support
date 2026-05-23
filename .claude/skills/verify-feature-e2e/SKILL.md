---
name: verify-feature-e2e
description: Drive a feature or bug-fix to "done" using an end-to-end feedback loop that runs the real app, asserts on observable behaviour, and iterates until green. On the way, captures the eventual passing recipe as a permanent script under scripts/e2e/ so it becomes a regression test. Use when the user asks to verify a feature works, confirm a bug is fixed, test a fix end-to-end, run the app and check a flow, or says "make sure X works" / "loop until it passes" / "test this in the real app". Composes with diagnose (for Phase 1 loop construction) and tdd (for unit-level slices). Use it after a feature or fix is implemented but before declaring done.
---

# Verify a feature or bug-fix end-to-end

The point of this skill is to **prove the change works in the running app**, not just that unit tests pass. Output of this skill is:
1. Confirmation (or rejection) that the feature/fix is done.
2. A reusable script under `scripts/e2e/<feature>.sh` so the same check runs as a regression test next time.

## When to use this vs other skills

| Situation | Use |
|---|---|
| Build a single unit slice with red-green-refactor | `tdd` |
| Hard bug, no idea what's wrong, need to find root cause | `diagnose` |
| Confirm a new feature or bug-fix works in the real app, end-to-end | **this skill** |
| One-off "did the change work" with no need to bottle it up | built-in `verify` |

Compose freely — Phase 1 below borrows directly from `diagnose`.

## Phase 1 — Define "done" before you touch anything

Write the acceptance criterion in **one sentence**, in terms of observable app behaviour. Examples:

- `POST /api/orders with valid body returns 201 and the order shows on GET /api/orders`
- `Clicking "Submit" on /signup creates a user row and redirects to /dashboard`
- `Running ./bin/import sample.csv produces stdout matching fixtures/import-expected.txt`

If you can't write this sentence, stop. Either the feature isn't specified well enough (go grill the user) or the bug report is missing repro steps (go gather them).

## Phase 2 — Build the feedback loop

Same as `diagnose` Phase 1: the loop is the skill. Try in order of cheapness:

1. **CLI invocation** with a fixture, diff stdout against a known-good file.
2. **HTTP curl script** against the running dev server, asserting status + JSON shape with `jq`.
3. **Headless browser** (Playwright/Puppeteer) for UI flows.
4. **Throwaway harness** that exercises the code path with one function call.

The loop must be:
- **Fast** — under ~10s ideally, so iteration is cheap.
- **Deterministic** — same input → same output. If it's flaky, fix the flake first.
- **Self-contained** — starts its own dependencies (server, db) or asserts they're up.

Run the loop **once before you change anything** to confirm it actually fails for the right reason. A loop that passes before your fix proves nothing.

## Phase 3 — Loop until green

```
while ! ./scripts/e2e/<feature>.sh; do
  read the failure output
  form one hypothesis
  make one minimal change
  commit nothing yet
done
```

Rules:
- **One change per iteration.** If two changes land together and it passes, you don't know which one fixed it.
- **No giving up.** If you've looped 5+ times with no progress, the loop itself is wrong — go back to Phase 2 and sharpen the assertion or shrink the surface.
- **Don't widen scope.** If you see other bugs, note them; don't fix them in this loop. (Open issues via `/triage` later.)

## Phase 4 — Promote the loop to a regression test

Once green, the loop you just used is valuable. Save it.

Run `scripts/scaffold-e2e-test.sh <feature-name>` to create `scripts/e2e/<feature-name>.sh` (project root, not in `.claude/`) with the standard structure:

```
#!/usr/bin/env bash
# e2e: <one-line feature description>
set -euo pipefail
trap cleanup EXIT

setup() { ... }
exercise() { ... }
assert() { ... }
cleanup() { ... }

setup; exercise; assert
```

Fill in the body from your Phase 2 loop. Wire it into your CI / pre-commit / `npm test:e2e` script so it runs unattended.

**If you ran 3+ different e2e scripts that follow the same pattern** (same setup, same teardown, only the exercise+assert differ), that's a repeatable workflow — invoke `write-a-skill` to capture it as a project-specific skill (e.g. `verify-payment-flow`, `verify-import`). Don't do this on the first one. Pattern only emerges after the third.

## Phase 5 — Report

Tell the user:

```
Feature: <name>
Acceptance criterion: <the one sentence from Phase 1>
Loop: scripts/e2e/<feature>.sh (n iterations to green)
Verdict: PASS
Regression test wired into: <CI step / npm script>
Notes: <any side bugs spotted but not fixed; link to opened issues>
```

If it didn't pass, say so clearly:

```
Verdict: BLOCKED
Loop: scripts/e2e/<feature>.sh
Last failure: <stderr excerpt>
Hypothesis exhausted: <what you tried>
Recommended next step: <ask user / open issue / pair with human>
```

## When you get blocked

- **Can't run the app locally** (missing service, missing creds): mock or stub the missing piece in a throwaway harness instead of waiting. Note the gap in the report.
- **Loop is flaky** (passes sometimes): treat flake-elimination as the *next* feature-fix cycle, with its own e2e loop. Don't paper over with retries.
- **Acceptance criterion is fuzzy**: stop and ask the user one sharp question — don't guess and waste iterations on the wrong target.
- **Same bug keeps coming back**: that means the test isn't asserting on the right thing. Tighten the assertion, don't just re-fix.
