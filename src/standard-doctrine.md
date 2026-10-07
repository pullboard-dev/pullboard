# Pullboard standard doctrine

Version: 1

## Rules
- PB1 [approved, must] Ask, don't guess: a decision only the person can make waits for them. | gate: review
- PB2 [approved, must] Destructive or irreversible actions wait for the person's OK. | gate: review
- PB3 [approved, must] Claims come with evidence: say what ran and what it showed, never "should work". | gate: review
- PB4 [approved, must] A test must be able to fail: see it fail on broken code before trusting it. | gate: review
- PB5 [approved, must] Never weaken a test or a check to make it pass; fix the code. | gate: review
- PB6 [approved, must] Tests pass before a change merges. | gate: the project's gate
- PB7 [pending, aim] Tests touch nothing outside a temporary sandbox. | gate: review
- PB8 [approved, must] No secrets or sensitive info in the repo; test data is synthetic. | gate: review
- PB9 [approved, must] Headers: type(scope): subject [ids], 72 characters at most. A body only for a non-obvious why, three sentences at most. | gate: commit-msg hook, review
- PB10 [approved, must] Comments explain why, not what; no commented-out code. | gate: review
- PB11 [approved, must] A new dependency states why it is needed and what it pulls in. | gate: review
- PB12 [approved, must] Questions go on the board, one step up the chain, and the asker keeps working on what it can meanwhile. | gate: review
- PB7: is "nothing outside a temporary sandbox" universal? Integration tests against local services may need more room.
