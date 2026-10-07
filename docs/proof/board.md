# Proof audit: the board rows

These board rows were built before the board could verify anything, so no accepted item vouched for them: B1, B2, B3, B4, B6, B7, B8, B9, B10, B12, B13, B14 and B15. This audit breaks each row's rule in `src/`, one change at a time, and checks that a test carrying the row's id goes red. Item #53 holds it; the verification rows have their own audit in [verification.md](verification.md).

Re-run it with `node docs/proof/board-mutants.mjs`. It shares its harness, `docs/proof/harness.mjs`, with the verification audit. The harness works on a temporary copy of the repo's tracked folders and changes nothing else. Before any change, it checks that each target test exists, matches exactly one test, and is green. It exits 1 if any change comes out other than expected.

| Row | Rule | Change that breaks it | Test that must go red | Result |
|---|---|---|---|---|
| B1 | One SQLite file in the git common dir; every worktree sees it. | each worktree opens a board of its own | the board lives in the git common dir; every worktree sees it; nothing is committed | red |
| B2 | Every move is one immediate transaction; two agents never hold one item. | a claim skips the check for another live holder | two agents racing for one item: exactly one wins, every time | red |
| B2 | | a move opens a deferred transaction | two agents racing for one item: exactly one wins, every time | red |
| B3 | An agent is its worktree; the main checkout is the coordinator. | the main checkout is not the coordinator | the board lives in the git common dir… | red |
| B3 | | an agent is whichever lane agent joined first | the board lives in the git common dir… | red, **after this audit** |
| B4 | A claim is a lease, 2h by default; claiming again renews it. | a lapsed claim stays held | a claim is a lease: renewable by its holder, free again once it lapses | red |
| B4 | | claiming again keeps the old lease | a claim is a lease… | red, **after this audit** |
| B4 | | the default lease is 3h | a claim's lease is 2h unless pullboard.json says otherwise | red, **new test** |
| B6 | Items cite spec ids that exist. | an item may cite an id the spec lacks | items cite spec ids that exist | red |
| B7 | Shouts reach a lane, an agent or all; inbox marks them read. | inbox never marks shouts read; a lane's shout misses its agents; a shout to all reaches nobody | shouts reach a lane, an agent or all; inbox marks them read | red, all three |
| B8 | An item can wait on others; claiming it is refused until they are verified. | an item waiting on another can be claimed | an item can wait on others: claiming it is refused until they are verified | red, **once tagged B8** |
| B9 | Submit pins the commit under refs/pullboard/items. | submit pins nothing | submit needs a clean tree, nothing untracked, and the gate green at HEAD | red, **once tagged B9** |
| B10 | An item carries a brief; next and show print it; edit changes it until verified. | a claimed item's brief cannot be edited | an item carries a brief; editing it changes how to build, never what | red |
| B10 | | next leaves out the brief; show leaves out the brief | an item carries a brief to whoever claims it | red, both |
| B12 | Every item is built in its own lane. | any lane may claim any item | one live top-level claim per agent; child items are free; lanes hold | red |
| B13 | Routes are tiers; an agent claims and verifies its tier and below. | any route takes any item | routes are tiers | red |
| B14 | Below strong, an item needs a criterion, a check and a brief. | an item below strong needs none of them | below strong, an item is buildable cold | red |
| B15 | Escalate frees an item one tier up, its attempt pinned and its failure attached. | escalate keeps the route | escalate frees an item one tier up, with what was tried attached | red |
| B15 | | escalate drops what was tried | escalate frees an item one tier up… | red, **after this audit** |
| B15 | | the runner never pins a failed attempt | run builds routed items unattended | red |

## What the audit changed

- **B3:** the test checked whoami in one lane worktree, so "the first agent that joined" passed for "this worktree's agent". It now adds a second worktree to the same lane, and each must say its own name.
- **B4:** the lease test renewed a claim without letting any time pass, so a renewal that kept the old expiry passed. It now renews an hour in and checks the claim still holds two hours after the first claim. The 2h default had no test at all; it has one now.
- **B8 and B9:** both were tested, B8 by a test whose title restates the row word for word, B9 inside the V4 test, but neither test named its row. They do now.
- **B15:** the escalate test checked the move and the route, not what travels with it. It now checks the event keeps the note and the pinned attempt.

## A gap in the audit harness itself

When `--test-name-pattern` matches no test, Node reports the test file itself as one passing test. The harness first counted reported tests, so a target that named no real test passed the baseline check. A change expected to stay green would then have looked proven while nothing ran. The harness now counts only results whose title holds the target's name, and refuses the run otherwise. The verification audit was re-run on the fixed harness: still 26 changes, 0 unexpected.
