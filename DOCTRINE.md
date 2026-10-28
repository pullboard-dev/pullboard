# Practice

How pullboard itself is built: the house rules, as rows. SPEC.md says what to build; this file says how. A row whose gate names a check fails the build when broken; a row gated by review guides agents and reviewers.

Statuses: approved = in force · draft = proposed · wont = considered and declined, id kept · retired = dropped, id kept. Ids are permanent: never delete or renumber a row. Tiers: must · aim.

## W · Writing
- W1 [approved, must] Numbers over adjectives. No hedges, no filler. | gate: review
- W2 [approved, must] Headers: type(scope): subject [ids], 72 characters, no emojis. A body only for a non-obvious why, three sentences at most. | gate: commit-msg hook, review
- W3 [approved, must] Spec ids go in commits, code headers and test names, never in words meant for people. | gate: review
- W4 [approved, must] A refusal names its rule as a code and says the next step. | gate: review
- W5 [draft, must] Tracked files and commit bodies never quote the owner or report what they said, chose or wanted, and never name private infrastructure: machine names, hostnames, LAN addresses or home paths. A commit is a subject line, then at most `Pullboard-Item: #N`. | gate: review

## C · Code
- C1 [approved, must] Plain JavaScript ES modules; no build step. | gate: package test
- C2 [approved, must] Zero runtime dependencies: every import is a node: built-in or a file in this repo. | gate: test/package.test.js
- C3 [approved, must] Every function has a JSDoc block: what it does, then why when that is not obvious. | gate: review
- C4 [approved, must] Refusals throw Refused(code, message); nothing else exits the process except the bin. | gate: review
- C5 [approved, must] Text from files or users is escaped before it reaches a page. | gate: test/view.test.js
- C6 [draft, aim] Functions under 60 lines and files under 1,000. | gate: review
- C9 [approved, must] Source and test files stay under 1500 lines; existing excess can only fall. Why: bounded files keep changes and reviews manageable. | gate: check node bin/checks/file-size.js | count: 38
- C8 [approved, must] No bare empty catch hides a failure; existing cases can only fall. Why: failures need handling or an explicit reason to ignore them. | gate: check node bin/checks/empty-catch.js | count: 11
- C10 [draft, must] No silent catch or fallback: each one logs a specific line that names its subject. Rigor names each catch clause and .catch handler a change adds to a source file that neither throws nor writes a line; a fallback written with a default operator is review. | gate: check node bin/pullboard.js rigor quality --rule silent-catch | count: 0 | source: rigor-quality:silent-catch
- C11 [draft, must] A file over the 1500-line cap, or a change that grows code past its 400-line budget, is named. Rigor names each changed source file that ends over 1500 lines and grew, and a change whose non-test code grows by more than 400 lines net, or the board's rigor.budget setting, at the file that grew most. | gate: check node bin/pullboard.js rigor quality --rule size-budget | count: 0 | source: rigor-quality:size-budget
- C12 [draft, must] Stylesheets take font sizes, spacing and corners from the scale in src/view.css; hand-typed sizes only fall. Why: one scale keeps every screen coherent. | gate: check node bin/checks/ui-sizes.js | count: 10

## T · Tests
- T1 [approved, must] Tests use node:test against real git repos and a real SQLite file, not mocks. | gate: review
- T2 [approved, must] Every test name cites the spec rows it proves. | gate: review
- T3 [approved, must] The suite passes on Node 22, 24 and 26 before a release. | gate: release check
- T4 [draft, must] A check that guards a rule is shown failing on a broken copy before anyone trusts it. | gate: review
- T5 [approved, must] Every test name cites the spec rows it proves; existing omissions can only fall. Why: a passing test must name the requirement it checks. | gate: check node bin/checks/test-names.js | count: 15
- T6 [approved, must] Tests declare the source files they read; existing omissions can only fall. Why: affected-test selection must see those dependencies. | gate: check node bin/checks/test-inputs.js | count: 17
- T7 [draft, must] A fix ships with a test that reproduces the original failure. Rigor names each fix commit that changes no test file, at the first line it changes; whether the test reproduces the failure is the root-cause-control rule. | gate: check node bin/pullboard.js rigor quality --rule fix-test | count: 0 | source: rigor-quality:fix-test
- T8 [draft, must] A new gate or check has a test that fails closed when it has no data. Rigor names a new file under checks/ or gates/, or named *-check or *-gate, that no test changed in the same change names; whether that test feeds it no data and expects a refusal is review, since no command can read what a test asserts. | gate: check node bin/pullboard.js rigor quality --rule fails-closed | count: 0 | source: rigor-quality:fails-closed
- T9 [draft, must] A guard test fails when the guard is deleted. Rigor turns each throw a change adds to a source file into a no-op, one at a time, and runs the test files the change touches; a guard they still pass without is named. | gate: check node bin/pullboard.js rigor quality --rule guard-mutation | count: 0 | source: rigor-quality:guard-mutation
- T10 [draft, must] A root cause is proven by a control that would have come out differently before the fix lands. Rigor runs each fix commit's changed test files on the fix's parent, where they must fail, and at the fix, where they must pass; a cause argued only in prose is review. | gate: check node bin/pullboard.js rigor quality --rule root-cause-control | count: 0 | source: rigor-quality:root-cause-control
- T11 [approved, must] Proof is what the board records. An agent keeps no evidence of its own; when the board's runs cannot decide an item, its bar is sharpened. | gate: review
- T12 [approved, must] Zero flaky tests. A test that gives two verdicts on the same tree is a defect. It is quarantined at once and never blocks an item. Its owner gets an item the same day, and the fix is at the cause: never a retry, a longer timeout or a skip. The count of flaky tests only falls. Baseline: 246 flaky tests (23 to 26 Oct 2026). | gate: review

## G · Git and the gate
- G1 [approved, must] `npm run gate` (spec check and tests) passes before every push. | gate: pre-push hook
- G2 [approved, must] Never bypass a hook. Never rewrite the main line, except to remove a secret. | gate: review
- G3 [approved, must] This repo's hooks run the source in this checkout. | gate: .githooks
- G4 [draft, aim] We aim to give every outside issue and pull request a first reply within 7 days. | gate: review

## S · Security
- S1 [approved, must] No secrets and no env files in git; test fixtures build fake secrets at run time. | gate: pre-commit secret scan
- S2 [approved, must] The board never stores source code, only ids, commits and digests. | gate: review
- S22 [draft, must] outside contributions are MIT, carry a DCO sign-off and are verified in a sandbox with no credentials or network. | gate: review
- S23 [draft, must] a change from outside that touches the relay, sealing, signing, person moves or hooks lands only with the owner's approval. | gate: review
- S24 [draft, must] never copy code from an issue or comment into Pullboard; reimplement it. Only code from a signed pull request is used. | gate: review

## DR · Rulings
- DR1 [draft, must] Consider splitting "docs/formats.md" into independently owned modules (for example, one module per command). It caused 12 conflict reopens and 0 conflict holds across items #418, #775, #801, #855, #918, #922, #940, #966, #1036 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoiZG9jcy9mb3JtYXRzLm1kIiwiZXZlbnRzIjpbMjk5ODgsMzAxOTksMzEyNzYsMzY3MDIsMzg4OTcsMzkwNjEsMzk4NTksNDU1MDcsNDY1NDMsNDc2MTcsNDc4NDMsNDgzNjJdfQ | gate: review
- DR2 [draft, must] Consider splitting "src/cli.js" into independently owned modules (for example, one module per command). It caused 13 conflict reopens and 0 conflict holds across items #836, #921, #928, #929, #957, #1047, #1048 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoic3JjL2NsaS5qcyIsImV2ZW50cyI6WzMyOTIxLDMyOTIzLDM2NTQ4LDM2NTUwLDM2NTUyLDM2NzA0LDM2ODMxLDM2ODMzLDM4NTA2LDQ0MjE1LDQ1MDMwLDQ2NjU5LDQ3NjY5XX0 | gate: review
- DR3 [draft, must] Consider splitting "src/machine.js" into independently owned modules (for example, one module per command). It caused 4 conflict reopens and 0 conflict holds across items #775, #801, #855, #940 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoic3JjL21hY2hpbmUuanMiLCJldmVudHMiOlsyOTk4OCwzMDE5OSwzNjcwMiwzODg5N119 | gate: review
- DR4 [draft, must] Consider splitting "src/board.js" into independently owned modules (for example, one module per command). It caused 7 conflict reopens and 0 conflict holds across items #966, #1047, #1048 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoic3JjL2JvYXJkLmpzIiwiZXZlbnRzIjpbNDQyMTUsNDQ5OTcsNDU1MDcsNDc2MTcsNDc4NDEsNDc4NDMsNDgzNjBdfQ | gate: review
- DR5 [draft, must] Consider splitting "src/cockpit.js" into independently owned modules (for example, one module per command). It caused 3 conflict reopens and 0 conflict holds across items #932, #937, #1060 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoic3JjL2NvY2twaXQuanMiLCJldmVudHMiOlszNjk1MywzNjk1Niw0NTUwNV19 | gate: review
- DR6 [draft, must] Consider splitting "src/commands/status.js" into independently owned modules (for example, one module per command). It caused 3 conflict reopens and 0 conflict holds across items #408, #960, #1048 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoic3JjL2NvbW1hbmRzL3N0YXR1cy5qcyIsImV2ZW50cyI6WzQwNTI5LDQ0OTk5LDQ4MDIyXX0 | gate: review
- DR7 [draft, must] Consider splitting "src/engine.js" into independently owned modules (for example, one module per command). It caused 3 conflict reopens and 0 conflict holds across items #918, #966, #1036 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoic3JjL2VuZ2luZS5qcyIsImV2ZW50cyI6WzM5MDYxLDQ1NTA3LDQ4MzYyXX0 | gate: review
- DR8 [draft, must] Consider splitting "src/land.js" into independently owned modules (for example, one module per command). It caused 2 conflict reopens and 0 conflict holds across items #418, #1061 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoic3JjL2xhbmQuanMiLCJldmVudHMiOls0NjAzNSw0NjgxNl19 | gate: review
- DR9 [draft, must] Consider splitting "src/runners.js" into independently owned modules (for example, one module per command). It caused 2 conflict reopens and 0 conflict holds across items #418, #1063 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoic3JjL3J1bm5lcnMuanMiLCJldmVudHMiOls0NDk5NSw0NjgxNl19 | gate: review
- DR10 [draft, must] Consider splitting "test/agent-model-engine.test.js" into independently owned modules (for example, one module per command). It caused 2 conflict reopens and 0 conflict holds across items #775, #855 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoidGVzdC9hZ2VudC1tb2RlbC1lbmdpbmUudGVzdC5qcyIsImV2ZW50cyI6WzI5OTg4LDMwMTk5XX0 | gate: review
- DR11 [draft, must] Consider splitting "test/pending-refreeze.test.js" into independently owned modules (for example, one module per command). It caused 2 conflict reopens and 0 conflict holds across items #775, #855 in 14 days; review the architecture before deciding. Source: conflict-split:eyJmaWxlIjoidGVzdC9wZW5kaW5nLXJlZnJlZXplLnRlc3QuanMiLCJldmVudHMiOlsyOTk4OCwzMDE5OV19 | gate: review

## CD · Cells (RFC 0006)
- CD1 [approved, must] Nothing blocks: 100+ agents now, 10,000 across a factory. (RFC 0006.) | gate: review
- CD2 [approved, must] A single source of truth: every fact lives in one place. (RFC 0006.) | gate: review
- CD3 [approved, must] Least confusion: familiar words and shapes, no new vocabulary in the file tree. (RFC 0006.) | gate: review
- CD4 [approved, must] Structure over intuition: rules a tool enforces, not habits. (RFC 0006.) | gate: review
- CD5 [approved, must] Declare intent, compute facts: only what a person decides is recorded, as a decision when it changes. (RFC 0006.) | gate: review
- CD6 [approved, must] Zero flaky tests. (RFC 0006.) | gate: review
- CD7 [approved, must] Plain JavaScript, no build step, no dependencies of any kind. (RFC 0006.) | gate: review
- CD8 [approved, must] Prove in small parts and roll out; never rewrite everything at once. (RFC 0006.) | gate: review
- CD9 [approved, must] Many agents first; models of about 27B parameters are the practical floor. (RFC 0006.) | gate: review
- CD10 [approved, must] Make the structure visible and queryable, so agents use it to go faster instead of being slowed by it. (RFC 0006.) | gate: review
- CD11 [approved, must] Every app and package is a cell; "cell" names the standard, never a folder. (RFC 0006.) | gate: review
- CD12 [approved, must] `apps/` holds what runs, and nothing imports an app; `packages/` holds what apps use. (RFC 0006.) | gate: review
- CD13 [approved, must] A cell is the unit of ownership, testing and context. (RFC 0006.) | gate: review
- CD14 [approved, must] Cell names are one lowercase word, never hyphenated; when one word is ambiguous, choose a more specific word. (RFC 0006.) | gate: review
- CD15 [approved, must] A cell is `index.js`, `src/core/`, `src/shell/`, `tests/` and `contract/`, and nothing else at its top level. (RFC 0006.) | gate: review
- CD16 [approved, must] No metadata file: the name is the folder, the purpose is the front door's comment, the owner is the lanes, and order is computed. (RFC 0006.) | gate: review
- CD17 [approved, must] No generated file is committed in a cell. (RFC 0006.) | gate: review
- CD18 [approved, must] Inside a cell, only code and its assets: no documents; docs live in the root `docs/`. (RFC 0006.) | gate: review
- CD19 [approved, must] Packages import each other only by name (`#pricing`) through one wildcard map in the root `package.json`, the only `package.json`. (RFC 0006.) | gate: review
- CD20 [approved, must] A root `jsconfig.json` lets editors follow `#` imports. (RFC 0006.) | gate: review
- CD21 [approved, must] `index.js` only re-exports: no logic and no side effects on import. (RFC 0006.) | gate: review
- CD22 [approved, must] Named exports only; no default export. (RFC 0006.) | gate: review
- CD23 [approved, must] No import cycles between cells. (RFC 0006.) | gate: review
- CD24 [approved, must] During the move, a package still in a cycle may import a named file inside another (`#store/src/board.js`) until it leaves the cycle. (RFC 0006.) | gate: review
- CD25 [approved, must] A split keeps the old name as a front door that re-exports, until its callers move. (RFC 0006.) | gate: review
- CD26 [approved, must] No TypeScript; types live only in contract tests, through a shape checker, never in comments. (RFC 0006.) | gate: review
- CD27 [approved, must] Only a front-door export carries a `/** */` comment: its purpose, in one sentence. Any other comment is a why that cites a row. (RFC 0006.) | gate: review
- CD28 [approved, must] A function with three or more parameters takes one named-options object instead. (RFC 0006.) | gate: review
- CD29 [approved, must] Every front-door export has a shape: a contract asserts its form, or the lint refuses it. (RFC 0006.) | gate: review
- CD30 [approved, must] A small kernel that features plug into; no central lists. (RFC 0006.) | gate: review
- CD31 [approved, must] The kernel package, named `kernel`, holds only ids, errors, registries and the plugin shape. (RFC 0006.) | gate: review
- CD32 [approved, must] A change to the kernel's front door needs the maintainer. (RFC 0006.) | gate: review
- CD33 [approved, must] Files aim for under 500 lines; 1,500 is the hard maximum. (RFC 0006.) | gate: review
- CD34 [approved, must] One concept per file, under the size limit. (RFC 0006.) | gate: review
- CD35 [approved, aim] A cell aims for 1,000–3,000 lines, merges under about 300, and splits over about 5,000. (RFC 0006.) | gate: review
- CD36 [approved, aim] Packages aim for a pure core and a thin shell; a target per package, never a gate. (RFC 0006.) | gate: review
- CD37 [approved, must] Prefer factories with passed-in dependencies to classes; plain objects for data. (RFC 0006.) | gate: review
- CD38 [approved, must] Shared mutable state outside shells only falls, measured per package. (RFC 0006.) | gate: review
- CD39 [approved, must] A shell reaches the outside (git, files, databases, processes, clocks, the environment, networks, browsers, keys) only through adapters, each with a fake proven by the adapter's contract tests. (RFC 0006.) | gate: review
- CD40 [approved, must] Configuration is JSON, never YAML. (RFC 0006.) | gate: review
- CD41 [approved, must] Contracts are consumer-written tests in the provider's `contract/`, citing rows; weakening one needs the owner. (RFC 0006.) | gate: review
- CD42 [approved, must] A contract's identity is its computed fingerprint plus a committed manifest of its tests. (RFC 0006.) | gate: review
- CD43 [approved, must] Removing or loosening a contract test needs the owner's decision on the board. (RFC 0006.) | gate: review
- CD44 [approved, must] The full suite is an audit, never a gate per change; a change walks up until a contract holds. (RFC 0006.) | gate: review
- CD45 [approved, must] Tests follow the import rules, and may use lower cells' front doors for fixtures. (RFC 0006.) | gate: review
- CD46 [approved, must] Shared test helpers live in a `testkit` package that any test may import. (RFC 0006.) | gate: review
- CD47 [approved, must] An integration test lives in the lowest cell or app that uses everything it tests; whole-system journeys live in apps. (RFC 0006.) | gate: review
- CD48 [approved, must] Each cell's own tests cover 100% of its branches; coverage from other cells' tests doesn't count. (RFC 0006.) | gate: review
- CD49 [approved, must] A test checks the code's own behavior; anything outside it appears only in its adapter's contract tests and in journeys. (RFC 0006.) | gate: review
- CD50 [approved, must] Each adapter switches between real and fake per run and per test; the audit runs everything real on a cadence, and any difference between real and fake becomes a contract test first. (RFC 0006.) | gate: review
- CD51 [approved, must] Each cell has one owner: the lane whose folders include it. (RFC 0006.) | gate: review
- CD52 [approved, must] An agent never edits another cell; it files an item for that cell's lane with the contract it needs. (RFC 0006.) | gate: review
- CD53 [approved, must] An agent's context is generated on demand from the cell's board and code, never a hand-written file. (RFC 0006.) | gate: review
- CD54 [approved, must] Generators, lints and golden examples come before any wiki or RAG for agent context. (RFC 0006.) | gate: review
- CD55 [approved, must] A feature is a parent item holding the person's bar; its work is child items. (RFC 0006.) | gate: review
- CD56 [approved, must] A feature's first child states the contract in the providing cell, approved by that cell's owner. (RFC 0006.) | gate: review
- CD57 [approved, must] Every child item touches exactly one cell; children in different cells build in parallel. (RFC 0006.) | gate: review
- CD58 [approved, must] A feature's last child is an integration test in the app that proves it end to end. (RFC 0006.) | gate: review
- CD59 [approved, must] Work that can't be cut by cell runs as a rare wide item in a serialized slot; its share only falls. (RFC 0006.) | gate: review
- CD60 [approved, must] Moving code between cells is its own item with a path map, never mixed with behavior. (RFC 0006.) | gate: review
- CD61 [approved, must] Nothing lives outside `apps/`, `packages/` and a short root allowlist; the lint refuses strays. (RFC 0006.) | gate: review
- CD62 [approved, must] Every package, export and file is reachable from an app; tests never count as reach. (RFC 0006.) | gate: review
- CD63 [approved, must] A file-name prefix repeated across files means a folder is missing. (RFC 0006.) | gate: review
- CD64 [approved, must] Pullboard restructures first, package by package, leaves first, behind shims, with file, shim and cycle counts that only fall. (RFC 0006.) | gate: review
- CD65 [approved, must] A strong model builds the move; a different model family verifies. (RFC 0006.) | gate: review

## CS · Cells (RFC 0006)
- CS1 [approved, must] A new dependency between cells is computed and flagged at submit, and the owner approves it on the board. (RFC 0006.) | gate: review
- CS2 [approved, must] Kernel churn is measured and reported weekly. (RFC 0006.) | gate: review
- CS3 [approved, must] An audit failure no contract predicted becomes a draft contract test through Rigor. (RFC 0006.) | gate: review
- CS4 [approved, must] Each cell holds a verdict keyed by its files and the contracts it reaches. (RFC 0006.) | gate: review
- CS5 [approved, must] The audit's cadence is computed: every √(2 × run cost ÷ (escapes per hour × delay cost)) hours. (RFC 0006.) | gate: review
- CS6 [approved, must] The queue sequences writers by cell at claim, so two agents never edit one place at once. (RFC 0006.) | gate: review
- CS7 [approved, aim] Items complete within minutes: a typical item goes from claim to landed in about 15 minutes. (RFC 0006.) | gate: review
- CS8 [approved, must] Collision mass (each file's conflict rate × the square of its share of changes, summed) and cells per item are measured weekly and only fall. (RFC 0006.) | gate: review
