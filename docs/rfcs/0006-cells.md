# RFC 0006: Cells, the structure of a codebase many agents build at once

- Status: Accepted.
- Drafted: 26 October 2026.
- Rule ids in brackets are the cells design board's; on approval each rule becomes a row in Pullboard's own spec with a new id.

## Summary

A codebase is a set of **cells**: every app under `apps/` and every package under `packages/`. A cell has one front door, its own tests, the contracts its users rely on, and no metadata file. Cells import each other only by name, with no cycles. Each cell has one owner. Work is cut so that an item changes one cell; a claim-time sequencer keeps two writers out of the same cell; tests run where they pay, and the full suite becomes an incremental audit.

The goal is a codebase where items complete within minutes and the number of agents that can work at once grows with the code, instead of being capped by its most contended files.

## Motivation

Measured on Pullboard's own board and git history, 12–26 October 2026:

- **Main kept moving under every item.** About 4 landings an hour; a typical item lived 12 hours from claim to landing, so dozens of other changes landed under it. There were 300 merge conflicts across 931 landings, and 2.46 submits per landed item.
- **Collisions follow the birthday problem.** Two changes in flight collide only if they share a file, and some files collide far more per touch than others. Fitting each file's own conflict rate on one week predicted the next week's conflicts within 25%, against 58% for simply repeating the first week. Shared lists (the API docs, the format notes, the move registry) carried 34% of all conflict pressure.
- **There is a peak.** With rework feeding back, useful output rises with agents, peaks near 1/(2k) agents for a collision constant k, then falls. For today's code: about 55 agents producing about 28 agents' worth of work. Adding agents past the peak makes the factory slower.
- **Time in flight is half of it.** What collides is changes in flight, including those waiting for review or landing: landing rate × hours from claim to landing (Little's law). About 34 changes were in flight; halving the hours halves the conflicts.
- **Tests cost more than they paid.** In two weeks: 561 flaky-test observations; of 113 reopens recorded as test failures, 65 were merge conflicts and 22 were reds already on main. Between 69% and 86% of test lines exercise three or more areas of the code, so almost every change reached almost every test.

Rewriting two weeks of real changes as if the code were structured differently: generating the shared lists raises the peak about 1.5×; splitting the hottest files 2.5–3×; giving each package its own tests about 4.4×. Cutting work so each item stays inside one package turns collisions into short waits and lifts capacity to roughly packages × writers per package.

A toy-app trial with parallel agents (810 landings) separated the effects. Folders alone did not reduce conflicts; the claim-time sequencer reduced them to zero; cells cut the tests run per landing about threefold.

## Constraints

Every rule below traces to one of these.

- [K1] Nothing blocks: 100+ agents now, 10,000 across a factory.
- [K2] A single source of truth: every fact lives in one place.
- [K3] Least confusion: familiar words and shapes, no new vocabulary in the file tree.
- [K4] Structure over intuition: rules a tool enforces, not habits.
- [K5] Declare intent, compute facts: only what a person decides is recorded, as a decision when it changes.
- [K6] Zero flaky tests.
- [K7] Plain JavaScript, no build step, no dependencies of any kind.
- [K8] Prove in small parts and roll out; never rewrite everything at once.
- [K9] Many agents first; models of about 27B parameters are the practical floor.
- [K10] Make the structure visible and queryable, so agents use it to go faster instead of being slowed by it.

## 1. What a cell is

- Every app and package is a cell; "cell" names the standard, never a folder. [S1]
- `apps/` holds what runs, and nothing imports an app; `packages/` holds what apps use. [S2]
- A cell is the unit of ownership, testing and context. [R18]
- Cell names are one lowercase word, never hyphenated; when one word is ambiguous, choose a more specific word. [R20]

**Why.** Apps and packages are the shape every JavaScript developer and model already knows (K3). A hyphenated name that repeats a concept (`relay-outbox-undo.js`) is a folder that doesn't exist yet; one-word names keep imports short and the tree honest.

## 2. Anatomy, and where each fact lives

```
packages/pricing/
  index.js        front door; its top comment is the purpose
  src/core/       pure functions
  src/shell/      input and output, dependencies passed in
  tests/          the cell's own tests
  contract/       one file per consumer
```

- A cell is `index.js`, `src/core/`, `src/shell/`, `tests/` and `contract/`, and nothing else at its top level. [S3]
- No metadata file: the name is the folder, the purpose is the front door's comment, the owner is the lanes, and order is computed. [S4, R28]
- No generated file is committed in a cell. [R23]
- Inside a cell, only code and its assets: no documents; docs live in the root `docs/`. [R48]

| Fact | Its one source |
|---|---|
| That it is a cell, app or package | Its folder |
| Its name | The folder name |
| Its purpose | The top comment of `index.js` |
| What it offers | The exports of `index.js` |
| What it promises | Its `contract/` tests |
| What it uses | Its imports, computed; a new dependency is a decision on the board |
| Its owner | The lanes in the root `pullboard.json` |
| Its order in the system | Computed from imports |

**Why.** Every metadata file tried in the design (a `cell.json`, a per-package `package.json`, a hand-written context file) either repeated what the code already said or went stale (K2). A per-package `package.json` also hides the root import map from Node. A document inside a cell is a second, unchecked description of the code beside the code.

## 3. The front door and imports

- Packages import each other only by name (`#pricing`) through one wildcard map in the root `package.json`, the only `package.json`. [S5]
- A root `jsconfig.json` lets editors follow `#` imports. [R11]
- `index.js` only re-exports: no logic and no side effects on import. [R24]
- Named exports only; no default export. [R25]
- No import cycles between cells. [R27]
- A new dependency between cells is computed and flagged at submit, and the owner approves it on the board. [R5]
- During the move, a package still in a cycle may import a named file inside another (`#store/src/board.js`) until it leaves the cycle. [R59]
- A split keeps the old name as a front door that re-exports, until its callers move. [R62]

**Why.** Importing by name means regrouping or splitting folders later changes only the root map. Declaring dependencies would duplicate the imports (K2, K5); approving each *new* edge records the intent at the moment it changes. A trial move of Pullboard found 40 of 44 proposed cells in one import cycle; importing by package name fails until that cycle is cut, while importing named files loads, so the transition rule is explicit and counted down.

## 4. Comments and types

- No TypeScript; types live only in contract tests, through a shape checker, never in comments. [R13]
- Only a front-door export carries a `/** */` comment: its purpose, in one sentence. Any other comment is a why that cites a row. [R16]
- A function with three or more parameters takes one named-options object instead. [R50]
- Every front-door export has a shape: a contract asserts its form, or the lint refuses it. [R12]

**Why.** A comment that states a type is a second source of truth that drifts; a contract test is executable and can't. The one comment worth keeping is the purpose of an export, because tools and other cells read it without opening the code. Named options for three or more parameters match how JavaScript is normally written and remove swapped-argument bugs.

## 5. The kernel and plugins

- A small kernel that features plug into; no central lists. [S11]
- The kernel package, named `kernel`, holds only ids, errors, registries and the plugin shape. [R30]
- A change to the kernel's front door needs the maintainer. [R31]
- Kernel churn is measured and reported weekly. [R32]

**Why.** Everything imports the kernel, so every change to it walks the whole system; it must be small and rarely change. Central lists that every feature appends to were the most conflicted files on the board; with discovery, there is nothing central to edit.

## 6. Size and shape

- Files aim for under 500 lines; 1,500 is the hard maximum. [S6]
- One concept per file, under the size limit. [R33]
- A cell aims for 1,000–3,000 lines, merges under about 300, and splits over about 5,000. [R9]
- Packages aim for a pure core and a thin shell; a target per package, never a gate. [R1]
- Prefer factories with passed-in dependencies to classes; plain objects for data. [R34]
- Shared mutable state outside shells only falls, measured per package. [R61]
- A shell reaches the outside (git, files, databases, processes, clocks, the environment, networks, browsers, keys) only through adapters, each with a fake proven by the adapter's contract tests. [R69]
- Configuration is JSON, never YAML. [S8]

**Why.** A cell should fit in one agent's context. Pure cores are hermetic by construction and cache exactly; the trial found most stateful services keep logic in their shell, so purity is a target, not a gate.

## 7. Contracts

- Contracts are consumer-written tests in the provider's `contract/`, citing rows; weakening one needs the owner. [S9]
- A contract's identity is its computed fingerprint plus a committed manifest of its tests. [R35]
- Removing or loosening a contract test needs the owner's decision on the board. [R36]
- An audit failure no contract predicted becomes a draft contract test through Rigor. [R37]

**Why.** A consumer writes down what it relies on (half-up rounding, line order), so a provider's change fails in the provider's own run, at its source. Contracts only cover what someone wrote down; the audit catches the rest, and Rigor turns each catch into a contract so the promises converge on the truth.

## 8. Tests

- Zero flaky tests. [K6]
- The full suite is an audit, never a gate per change; a change walks up until a contract holds. [S10]
- Each cell holds a verdict keyed by its files and the contracts it reaches. [R38]
- Tests follow the import rules, and may use lower cells' front doors for fixtures. [R29]
- Shared test helpers live in a `testkit` package that any test may import. [R60]
- An integration test lives in the lowest cell or app that uses everything it tests; whole-system journeys live in apps. [R52]
- Each cell's own tests cover 100% of its branches; coverage from other cells' tests doesn't count. [R51]
- The audit's cadence is computed: every √(2 × run cost ÷ (escapes per hour × delay cost)) hours. [R39]
- A test checks the code's own behavior; anything outside it appears only in its adapter's contract tests and in journeys. [R68]
- Each adapter switches between real and fake per run and per test; the audit runs everything real on a cadence, and any difference between real and fake becomes a contract test first. [R70]

**Why.** A test run pays when the chance it catches a real defect in this change, times the cost of that defect escaping, beats its runtime plus the cost of a false red. That places every test at submit, at landing, or in the audit. Nothing should cost time in proportion to the whole repository per change, so the audit itself reruns only what changed since it was last green. Coverage is measured per cell, because when a cell changes, other cells' tests often don't run. Most test time today goes to real processes, repositories, databases and browsers rather than to the code under test: about three-quarters of test files touch at least one. A spawned process with a few git calls costs up to a second; the same check against a contract-tested fake costs milliseconds.

## 9. Ownership, context and working at once

- Each cell has one owner: the lane whose folders include it. [R40]
- An agent never edits another cell; it files an item for that cell's lane with the contract it needs. [R4]
- An agent's context is generated on demand from the cell's board and code, never a hand-written file. [R2]
- Generators, lints and golden examples come before any wiki or RAG for agent context. [R6]
- The queue sequences writers by cell at claim, so two agents never edit one place at once. [R17]
- A feature is a parent item holding the person's bar; its work is child items. [R53]
- A feature's first child states the contract in the providing cell, approved by that cell's owner. [R54]
- Every child item touches exactly one cell; children in different cells build in parallel. [R55]
- A feature's last child is an integration test in the app that proves it end to end. [R56]
- Work that can't be cut by cell runs as a rare wide item in a serialized slot; its share only falls. [R57]
- Moving code between cells is its own item with a path map, never mixed with behavior. [R42]

**Why.** Structure raises the peak about 4×; past that, the limit is how work is cut. An average change touched 2.6 areas and only 42% stayed in one. One-cell items, sequenced by cell, turn collisions into short waits, so capacity becomes packages × writers per package and grows with the code.

## 10. Keeping the structure clean

- Nothing lives outside `apps/`, `packages/` and a short root allowlist; the lint refuses strays. [R44]
- Every package, export and file is reachable from an app; tests never count as reach. [R49]
- A file-name prefix repeated across files means a folder is missing. [R21]

## 11. Measures

- Items complete within minutes: a typical item goes from claim to landed in about 15 minutes. [G4]
- Collision mass (each file's conflict rate × the square of its share of changes, summed) and cells per item are measured weekly and only fall. [R58]

`pullboard capacity` reports both, with its own error on a held-out window.

## Adopting it

- Pullboard restructures first, package by package, leaves first, behind shims, with file, shim and cycle counts that only fall. [G3, S13]
- A strong model builds the move; a different model family verifies. [S12]
- Prerequisites before the first package moves: history follows a path map; tools understand `#name` and `packages/*/tests`; fixtures and runner copies follow the package list; a `testkit`; ratchet lints.

## Not yet decided

- Cells as boards, with approval following the tree. [R3]
- Engine numbers as per-package versions. [R8]
- A board per cell or per group of cells. [R41]
- How a user's repo becomes cells. [R43]
- The factory mechanic flagging misplaced files. [R46]

## Evidence

Kept with the design (private until published): the trial move of Pullboard on a scratch clone; four toy-app rounds, the last with parallel agents; the per-file collision model and its held-out test; a study of a week's main-red items; the test value data above.

<!-- cells-rule-map:start -->
## Appendix: Pullboard rule ids

This mapping translates the design board's citations into this repository's permanent rows. The approved RFC body above is unchanged; its design ids are historical citations, not reused row ids.

| Design id | Pullboard row | File |
| --- | --- | --- |
| K1 | CD1 | DOCTRINE.md |
| K2 | CD2 | DOCTRINE.md |
| K3 | CD3 | DOCTRINE.md |
| K4 | CD4 | DOCTRINE.md |
| K5 | CD5 | DOCTRINE.md |
| K6 | CD6 | DOCTRINE.md |
| K7 | CD7 | DOCTRINE.md |
| K8 | CD8 | DOCTRINE.md |
| K9 | CD9 | DOCTRINE.md |
| K10 | CD10 | DOCTRINE.md |
| S1 | CD11 | DOCTRINE.md |
| S2 | CD12 | DOCTRINE.md |
| R18 | CD13 | DOCTRINE.md |
| R20 | CD14 | DOCTRINE.md |
| S3 | CD15 | DOCTRINE.md |
| S4 | CD16 | DOCTRINE.md |
| R28 | CD16 | DOCTRINE.md |
| R23 | CD17 | DOCTRINE.md |
| R48 | CD18 | DOCTRINE.md |
| S5 | CD19 | DOCTRINE.md |
| R11 | CD20 | DOCTRINE.md |
| R24 | CD21 | DOCTRINE.md |
| R25 | CD22 | DOCTRINE.md |
| R27 | CD23 | DOCTRINE.md |
| R5 | CS1 | DOCTRINE.md |
| R59 | CD24 | DOCTRINE.md |
| R62 | CD25 | DOCTRINE.md |
| R13 | CD26 | DOCTRINE.md |
| R16 | CD27 | DOCTRINE.md |
| R50 | CD28 | DOCTRINE.md |
| R12 | CD29 | DOCTRINE.md |
| S11 | CD30 | DOCTRINE.md |
| R30 | CD31 | DOCTRINE.md |
| R31 | CD32 | DOCTRINE.md |
| R32 | CS2 | DOCTRINE.md |
| S6 | CD33 | DOCTRINE.md |
| R33 | CD34 | DOCTRINE.md |
| R9 | CD35 | DOCTRINE.md |
| R1 | CD36 | DOCTRINE.md |
| R34 | CD37 | DOCTRINE.md |
| R61 | CD38 | DOCTRINE.md |
| R69 | CD39 | DOCTRINE.md |
| S8 | CD40 | DOCTRINE.md |
| S9 | CD41 | DOCTRINE.md |
| R35 | CD42 | DOCTRINE.md |
| R36 | CD43 | DOCTRINE.md |
| R37 | CS3 | DOCTRINE.md |
| S10 | CD44 | DOCTRINE.md |
| R38 | CS4 | DOCTRINE.md |
| R29 | CD45 | DOCTRINE.md |
| R60 | CD46 | DOCTRINE.md |
| R52 | CD47 | DOCTRINE.md |
| R51 | CD48 | DOCTRINE.md |
| R39 | CS5 | DOCTRINE.md |
| R68 | CD49 | DOCTRINE.md |
| R70 | CD50 | DOCTRINE.md |
| R40 | CD51 | DOCTRINE.md |
| R4 | CD52 | DOCTRINE.md |
| R2 | CD53 | DOCTRINE.md |
| R6 | CD54 | DOCTRINE.md |
| R17 | CS6 | DOCTRINE.md |
| R53 | CD55 | DOCTRINE.md |
| R54 | CD56 | DOCTRINE.md |
| R55 | CD57 | DOCTRINE.md |
| R56 | CD58 | DOCTRINE.md |
| R57 | CD59 | DOCTRINE.md |
| R42 | CD60 | DOCTRINE.md |
| R44 | CD61 | DOCTRINE.md |
| R49 | CD62 | DOCTRINE.md |
| R21 | CD63 | DOCTRINE.md |
| G4 | CS7 | DOCTRINE.md |
| R58 | CS8 | DOCTRINE.md |
| G3 | CD64 | DOCTRINE.md |
| S13 | CD64 | DOCTRINE.md |
| S12 | CD65 | DOCTRINE.md |

The undecided design items R3, R8, R41, R43 and R46 have no approved row.
<!-- cells-rule-map:end -->

## Note on moves behind shims

During a move behind shims, each old source path re-exports through the cell's `packages/<cell>/index.js`, never a moved leaf directly. Keep that front door and its package reachable from a production app. `node packages/codemap/src/io/cells/scripts/plan.js --moved <cell>` checks the shim targets and production reachability before the move is submitted. This note sits outside the approved body; it applies [R62] and changes no row.

## Amendment, 31 October 2026: local sealing

Approved by the person on 31 October 2026 ("Seals are approved"; Proposal A). These rows make §8's verdict rule [R38] concrete. The approved body above is unchanged; these rows add to it. Proof that travels between boards stays in RFC 0007, rescoped to that question.

- A cell's verdict is keyed to a content hash of its files and assets plus the hashes of the front doors it imports. [A1]
- Invalidation is computed, never judged: a change unseals exactly the cells whose hash it changes, through the import graph. [A2]
- Submit and landing run only the tests of the cells a change unseals, plus contracts at changed front doors; journeys [R52] run per landing batch. [A3]
- An item proves once: review and landing reuse its proof and add only the merge composition and the batch's journeys. [A4]
- A reviewer cites a sealed cell's verdict receipt instead of re-checking it. [A5]
- Until seals exist, a generated tier manifest classifies each test file (one cell and pure, or infrastructure and journey), and per-change selection uses only the touched cells' tests. [A6]

**Why.** None of §8 was built, so every change ran heavy tests: about 1.5 runner-hours per item, with 93% of builder time going to tools. Keying verdicts to content makes a change pay only for the cells it actually changes, which turns minutes of testing per item into about a minute now, and toward none once seals hold.

## Standing rules and the check that enforces each

These rules stay after the move plan is retired. Each line names the static check class that refuses its breach, as `check: <name>`; a class name is one in `pullboard doctor`'s static registry, and a metric after a slash is one of the cell lints' counters.

- A cell is a folder: the folder that holds a file names its cell, and a file outside every cell or the root allowlist is refused. [CD11, CD61] check: cell-lints/strays
- Cells import each other only through the front door: a deep import into another cell's `src` is refused. [CD19] check: cells-edges
- The allowed cross-cell edges are one declared rule: an undeclared new import is refused. [CD19] check: cells-edges
- No import cycle between cells: an edge that closes a cycle is refused. [CD23] check: cell-lints/cycles
- The shim ratchet: re-export shims only fall, never grow. [CD25, CD64] check: cell-lints/shims
- File size caps: 500 lines is the aim and 1,500 the hard maximum, and an oversized file takes no added lines. [CD33] check: cell-lints/fileSize

## Amendment, 20 November 2026: standing cell rules after the restructure

These are the rules that stay once the restructure plan in `packages/codemap/data/plan/` is retired. The approved body above is unchanged; this amendment adds to it. Each rule names the check that refuses its breach as `check: <name> (<file>)`, and the file is one that exists in the tree.

- A file belongs to the cell whose folder holds it. check: cells-edges (`packages/gate/src/io/edges.js`)
- A cross-cell import goes through the other cell's front door, never into its `src`. check: cells-edges (`packages/gate/src/io/edges.js`)
- Allowed cell edges live in the one declared rule file; an undeclared edge is refused. check: cells-edges (`packages/codemap/data/ceilings/allowed-edges.json`)
- The cell import graph has no cycle. check: cell-lints/cycles (`packages/codemap/src/io/cell/lints.js`)
- New source outside a cell or the root allowlist is refused. check: cell-lints/strays (`packages/codemap/src/logic/allowlist.js`, `packages/codemap/src/logic/layout.js`)
- The shim ratchet and the file size caps stay. check: cell-lints/shims and cell-lints/fileSize (`packages/codemap/src/io/cell/lints.js`)
