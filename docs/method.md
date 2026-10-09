# The Pullboard method

_The README is canon. Where this page and the README differ, the README wins._

A way to run a team of coding agents on one codebase so that the work they report as done is done. It fits on one page because it is mostly one rule.

> **Nothing ships until a second agent turns its key.**

The rule is old. Banks call it maker-checker, auditors the four-eyes principle, and missile crews the two-person rule: the person who does the work is never the one who signs it off. What is new is applying it to agents, which write faster than any person can read and, left alone, mark their own work as passing.

## Roles

- **The person** decides. They turn the client's ask into the spec, approve rows, settle open questions, and sign off what is met. Their judgment is the scarce input; the method exists to spend it where it counts.
- **The coordinator** is the agent in the main checkout. It turns spec rows into items, verifies lane work, merges, and owns every path no lane owns.
- **Lane agents** build. Each works in its own worktree, owns a set of folders, and claims one item at a time.

## The six steps

### 1. Start from the ask

Write down what the client asked for in their words before deciding anything. Every later argument about scope ends here.

### 2. Turn it into lettered points

Every requirement becomes one row with an id, a status and the check that proves it:

```
- G1.2 [approved, must] Same file twice is a no-op. | gate: idempotency test
```

- **One row, one line, one id.** Ids are never reused, so a commit that cites `G1.2` means the same thing a year later.
- **Prefixes are tracks.** `G` for the client's goals, `K` for constraints, `S` for security, whatever the product needs. Letters group; numbers order.
- **Status says how settled it is.** approved means decided, draft means proposed, pending means an open question, fact means true today, retired means spent.
- **Every approved must-row names its gate:** the test or check that will prove it. A requirement nobody can check is a wish.

### 3. Build against the spec

Each item cites the rows it serves. The first claim freezes the item's criterion and the text of those rows: the bar is fixed before the work starts and cannot move under the builder or the verifier. If the person changes a row, the coordinator refreezes the item in the open and the work is claimed again.

### 4. Split the work into lanes

A lane owns folders. Agents in different lanes never edit the same files, so they never collide; a change outside your lane is refused at commit, and you shout the owner instead. Shared contracts (types, schema, the lockfile) belong to the coordinator, who changes them on the main line for everyone.

### 5. A second agent verifies

Submitting needs a clean tree and the gate green at the exact commit. Then a different agent checks out that commit and judges it against the frozen criterion:

- **ACCEPT** only when the criterion is met.
- **REJECT** names what failed (TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD, OTHER) with a note the builder can act on. The item reopens, and the same commit can never be submitted again.

Prefer evidence that would fail if the work were wrong: revert the fix and watch the test go red. A test that passes either way proves nothing.

### 6. A person drives

The person reads the ledger, not every diff. They decide pending rows, sign off approved ones against the text they read (a sign-off goes stale if the row changes), and move the bar only in the open.

## Rules

1. The builder never verifies its own work.
2. The criterion freezes at first claim.
3. A verdict binds the submitted commit and the frozen criterion.
4. Done means the gate is green at that commit, on a clean tree.
5. Rejected work comes back at a new head.
6. Lanes own folders; changes outside your lane go through the owner.
7. Commits cite the spec rows they serve.
8. One live claim per agent; a claim is a lease.
9. The bar moves only in the open: refreeze, logged.
10. Never bypass a hook or edit the board's database.

## What it does not do

It does not review code for you, resolve merge conflicts, or decide what to build. It makes sure that what agents report as done was checked by someone who did not build it, against a bar that did not move, at the commit that ships, and it leaves a record anyone can read.
