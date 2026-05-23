# LLM-as-judge rubric for skill outputs

Use when comparing two versions of a skill (Layer 3 of the evaluate-skill methodology). Score each output **independently** on every dimension, 1–5, then pick a winner per dimension and an overall winner. Always include one sentence of evidence per score — no bare numbers.

## Scoring dimensions

### 1. Organization (1–5)
Does the output have a clear structure? Is it easy to scan? Are headings, bullets, and sections used purposefully (not as decoration)?

- 1 — wall of text or random order
- 3 — readable, some structure
- 5 — every section earns its place, scannable in seconds

### 2. Clarity (1–5)
Is the language concrete and unambiguous? Could a competent reader execute it without follow-up questions?

- 1 — vague, hedged, full of "consider" / "might"
- 3 — mostly clear, a few ambiguous spots
- 5 — every step has a single obvious interpretation

### 3. Actionability (1–5)
Does the output drive the reader toward a specific next action? Are commands runnable, files writable, paths concrete?

- 1 — describes the problem but offers no path forward
- 3 — suggests actions but leaves user to assemble them
- 5 — copy-pasteable commands or step-by-step that just works

### 4. Token efficiency (1–5)
Is the output as concise as it can be **without losing precision**? Penalise filler ("In order to...", "It's worth noting that...") and redundant restatements.

- 1 — every sentence could be cut in half
- 3 — average — some tightening possible
- 5 — every word earns its place; cutting more would lose meaning

### 5. Scope discipline (1–5)
Does the output stay within the skill's stated purpose? Penalise scope creep (extra features the user didn't ask for, gratuitous refactors, unrelated suggestions).

- 1 — wanders far outside the skill's job
- 3 — mostly on-task with some drift
- 5 — exactly what the skill is for, nothing more

## Blind comparison protocol

Critical: the judge must not know which output came from which version.

1. Random-shuffle outputs as "Output 1" and "Output 2".
2. Prompt the judge with: the user's original prompt, both outputs, this rubric.
3. Ask the judge to return a JSON object:
   ```json
   {
     "output_1": {"organization": 4, "clarity": 5, "actionability": 4, "tokens": 3, "scope": 5, "evidence": {"organization": "...", "clarity": "...", "actionability": "...", "tokens": "...", "scope": "..."}},
     "output_2": {...},
     "winners": {"organization": "output_1", ...},
     "overall_winner": "output_1",
     "overall_reason": "one sentence"
   }
   ```
4. Only after the judge returns: reveal the mapping and decide whether to ship the change.

If the judge picks the regression, **trust the judge over the author's gut**. That's the whole point of blind comparison.

## When the judge disagrees with mechanical evals

If Layer 2 says version B passes more assertions but Layer 3 says version A is better-written, the *assertions* are usually the weak link — they let through low-quality outputs. Sharpen the assertions and re-grade.
