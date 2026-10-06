# Practice

How pullboard itself is built: the house rules, as rows. SPEC.md says what to build; this file says how. A row whose gate names a check fails the build when broken; a row gated by review guides agents and reviewers.

Statuses: approved = in force · draft = proposed · wont = considered and declined, id kept · retired = dropped, id kept. Ids are permanent: never delete or renumber a row. Tiers: must · aim.

## W · Writing
- W1 [approved, must] Numbers over adjectives. No hedges, no filler. | gate: review
- W2 [approved, must] Commit headers are type(scope): subject [ids], 72 characters at most, no emojis. | gate: commit-msg hook
- W3 [approved, must] Spec ids go in commits, code headers and test names, never in words meant for people. | gate: review
- W4 [approved, must] A refusal names its rule as a code and says the next step. | gate: review

## C · Code
- C1 [approved, must] Plain JavaScript ES modules; no build step. | gate: package test
- C2 [approved, must] Zero runtime dependencies: every import is a node: built-in or a file in this repo. | gate: test/package.test.js
- C3 [approved, must] Every function has a JSDoc block: what it does, then why when that is not obvious. | gate: review
- C4 [approved, must] Refusals throw Refused(code, message); nothing else exits the process except the bin. | gate: review
- C5 [approved, must] Text from files or users is escaped before it reaches a page. | gate: test/view.test.js
- C6 [draft, aim] Functions under 60 lines and files under 1,000. | gate: review

## T · Tests
- T1 [approved, must] Tests use node:test against real git repos and a real SQLite file, not mocks. | gate: review
- T2 [approved, must] Every test name cites the spec rows it proves. | gate: review
- T3 [approved, must] The suite passes on Node 22, 24 and 26 before a release. | gate: release check
- T4 [draft, must] A check that guards a rule is shown failing on a broken copy before anyone trusts it. | gate: review

## G · Git and the gate
- G1 [approved, must] `npm run gate` (spec check and tests) passes before every push. | gate: pre-push hook
- G2 [approved, must] Never bypass a hook. Never rewrite the main line, except to remove a secret. | gate: review
- G3 [approved, must] This repo's hooks run the source in this checkout. | gate: .githooks

## S · Security
- S1 [approved, must] No secrets and no env files in git; test fixtures build fake secrets at run time. | gate: pre-commit secret scan
- S2 [approved, must] The board never stores source code, only ids, commits and digests. | gate: review
