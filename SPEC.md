# Pullboard local

The local-first core of Pullboard: a work board, lanes, a spec and git hooks that live in the repo. No account, no network. This file is the spec, in the format `pullboard spec check` lints.

Statuses: approved = decided · draft = proposed · pending = open question · fact = true today · wont = won't build, decided and kept · retired = no longer applies, kept. Ids are permanent: never delete or renumber a row. Tiers: must · aim.

## P · Principles
- P1 [approved, must] Nothing ships until a second agent verifies it. | gate: test/board.test.js
- P2 [approved, must] Works offline in any git repo. No account, no network. | gate: test/e2e.test.js
- P3 [approved, must] Zero runtime dependencies. Node 22.13 or newer. | gate: test/package.test.js
- P4 [approved, must] Every refusal names its rule and the next step. | gate: review
- P5 [approved, must] The core names no model, inference engine or model vendor, and opens no outbound connection. | gate: test/boundary.test.js

## B · Board
- B1 [approved, must] One SQLite file in the git common dir. Every worktree sees it; nothing is committed. | gate: test/e2e.test.js
- B2 [approved, must] Every move is one immediate transaction. Two agents never hold one item. | gate: test/e2e.test.js | serves: P1
- B3 [approved, must] An agent is its worktree. The main checkout is the coordinator. | gate: test/e2e.test.js
- B4 [approved, must] A claim is a lease, 2h by default. Claiming again renews it. | gate: test/board.test.js
- B5 [approved, must] One live top-level claim per agent, plus reworks of its own rejected items. Child items are free. | gate: test/board.test.js
- B6 [approved, must] Items cite spec ids that exist. | gate: test/e2e.test.js | serves: S1
- B7 [approved, must] Shouts reach a lane, an agent or all. Inbox marks them read. | gate: test/board.test.js
- B8 [approved, must] An item can wait on others; claiming it is refused until they are verified. | gate: test/board.test.js
- B9 [approved, must] Submit pins the commit under refs/pullboard/items, so submitted work is never lost. | gate: test/e2e.test.js
- B10 [approved, must] An item carries a brief: how to build it. Next and show print it; edit changes it until verified. | gate: test/board.test.js, test/e2e.test.js
- B11 [retired] Items route strong or light; B13 replaced the two routes with three tiers.
- B12 [approved, must] Every item is built in its own lane; the coordinator claims only coordinator-lane items. | gate: test/board.test.js | serves: L3
- B13 [approved, must] Routes are tiers: light, mid, strong. An agent claims and verifies its tier and below, its own first. | gate: test/board.test.js | serves: B10
- B14 [approved, must] Below strong, an item needs a criterion, a check command, and a brief naming its test and in-lane files. | gate: test/board.test.js, test/e2e.test.js | serves: B10
- B15 [approved, must] Escalate frees an item one tier up, its attempt pinned and its failure attached. | gate: test/board.test.js, test/e2e.test.js | serves: B13
- B16 [approved, must] When only work above an agent's tier is open in its lane, next names it and the ways through. | gate: test/board.test.js | serves: B13
- B17 [draft, must] Every agent on a board runs one tested version of pullboard, never a checkout's unfinished edits. | gate: test/e2e.test.js | serves: P1
- B18 [draft, aim] An item can wait until a time; next and claim pass over it until then. | gate: test/board.test.js | serves: B8
- B19 [draft, aim] An item can wait until main contains a given commit; next and claim pass over it until then. | gate: test/e2e.test.js | serves: B8
- B20 [draft, aim] The person orders open items: now, next or later, and up or down within each; next follows it first. | gate: test/board.test.js
- B21 [approved, aim] A shout can ask for a decision; it stays in the person's Needs-you until someone answers it. | gate: test/board.test.js | serves: B7
- B22 [approved, aim] A shout can attach typed evidence: attempt or receipt, outcome, item and commit, as fields, not prose. | gate: test/board.test.js | serves: B7
- B23 [approved, aim] A shout's path:lines@commit reference opens that code as it was at that commit. | gate: test/cockpit.test.js | serves: B7

## M · Machine
- M1 [approved, must] One declaration holds every item state, move, guard and refusal; code, help and docs derive from it. | gate: test/machine.test.js
- M2 [approved, must] Every way into a final state passes that state's exit guards, whatever command gets there. | gate: test/machine.test.js | serves: P1
- M3 [approved, must] The board file refuses an undeclared move, and verified without an ACCEPT at the submitted commit. | gate: test/machine.test.js | serves: P1
- M4 [approved, must] A property check proves the declaration: every state reachable, none a trap, every refusal naming a next step. | gate: test/machine.test.js | serves: M1

## V · Verification
- V1 [approved, must] The builder never verifies its own work. | gate: test/board.test.js | serves: P1
- V2 [approved, must] The criterion freezes at first claim: title, criterion and cited spec rows. | gate: test/board.test.js | serves: P1
- V3 [approved, must] Verify refuses when the frozen criterion has changed. | gate: test/e2e.test.js | serves: V2
- V4 [approved, must] Submit needs a clean tree and the gate green at HEAD. | gate: test/e2e.test.js
- V5 [approved, must] ACCEPT needs CRITERION_MET and a note of the proof. REJECT needs a reason code and a note. | gate: test/board.test.js
- V6 [approved, must] REJECT reopens the item. Resubmitting needs a new head. | gate: test/board.test.js
- V7 [approved, must] The verifier's checkout contains the submitted commit. | gate: test/e2e.test.js
- V8 [approved, must] Every verdict binds the submitted commit and the frozen digest. | gate: test/board.test.js
- V9 [approved, must] In the main checkout, verifying needs --as coordinator, so no agent's verdict is filed as the coordinator's. | gate: test/e2e.test.js | serves: V1
- V10 [approved, must] Agents see a gate digest: one line when green, the failures when red; the full log stays in .git. | gate: test/e2e.test.js | serves: V4
- V11 [approved, must] Submit refuses when the cited rows changed since claim, before a verifier spends a run on it. | gate: test/e2e.test.js | serves: V3
- V12 [approved, must] Verify and escalate take --note-file, so a note reaches the board exactly as written. | gate: test/e2e.test.js | serves: V5
- V13 [draft, must] Every verdict records the verifier's HEAD; show and the ledger flag a review made past the submitted commit. | gate: test/board.test.js | serves: V8
- V14 [draft, must] The bar is the frozen criterion alone. The brief can change, so it guides building, never the verdict. | gate: test/practice.test.js | serves: V2
- V15 [approved, must] `next --verify` reserves the review under a lease; another verdict on it is refused while the lease lives. | gate: test/machine.test.js | serves: V1
- V16 [approved, must] Submit runs the gate itself on the exact tree it submits; no stamp from an earlier run stands in. | gate: test/gate.test.js | serves: P1
- V17 [draft, must] Submit refuses a head carrying commits pinned to another item that is not verified. | gate: test/e2e.test.js | serves: V6

## O · Options
- O1 [draft, must] pullboard.json options switch declared guards on or off per repo; show and the view list them. | gate: test/machine.test.js | serves: M1
- O2 [draft, aim] verify.family: off, prefer or require a verifier from a model family that built none of it. | gate: test/board.test.js | serves: V1
- O3 [draft, aim] Agents declare their model family on joining; submissions and verdicts record it. | gate: test/board.test.js | serves: O2
- O4 [draft, aim] verify.at: contains, today's rule, or exact, which refuses a verdict unless HEAD is the submitted commit. | gate: test/e2e.test.js | serves: V7

## L · Lanes
- L1 [approved, must] Lanes live in pullboard.json: folders owned, spec prefixes, when it starts. | gate: test/lanes.test.js
- L2 [approved, must] The longest owned prefix decides a path's lane. Unowned paths are the coordinator's. | gate: test/lanes.test.js
- L3 [approved, must] In a lane's worktree, pre-commit refuses changes outside the lane, moves included. | gate: test/e2e.test.js
- L4 [approved, must] A worktree that has not joined a lane cannot commit. | gate: test/e2e.test.js

## S · Spec
- S1 [approved, must] SPEC.md holds one row per line: id, status, text, gate, what it serves. | gate: test/spec.test.js
- S2 [approved, must] Ids are unique forever. Retired rows stay, so no id is reused. | gate: test/spec.test.js
- S3 [approved, must] Serves links name real ids and never cycle. | gate: test/spec.test.js
- S4 [approved, must] Approved must-rows name their gate. | gate: test/spec.test.js
- S5 [approved, must] A sign-off keeps the text it approved. Changing the row makes it stale. | gate: test/spec.test.js
- S6 [approved, must] PRACTICE.md holds the house rules in the same row format; spec check lints both. | gate: test/practice.test.js
- S7 [approved, must] `pullboard spec view` renders spec, questions, sign-offs and practice as one offline page. | gate: test/view.test.js
- S8 [approved, must] Ids are permanent. Commit refuses a deleted row; spec check finds ids once committed or cited, now gone. | gate: test/e2e.test.js, test/spec.test.js
- S9 [approved, must] A wont row stays with its id, out of the counts; nothing new may cite it. | gate: test/spec.test.js
- S10 [approved, must] At an older commit, spec check skips ids that items cite and a later commit added. | gate: test/e2e.test.js | serves: S8
- S11 [approved, must] pullboard.json names products, each a list of spec ids or section letters, as lanes list theirs. | gate: test/products.test.js
- S12 [approved, must] Lanes and items belong to the product of their spec prefixes and cited rows; nothing restates it. | gate: test/products.test.js | serves: S11

## D · Doctrine
- D1 [draft, must] Doctrine has three scopes: system (every repo here), repo and lane; a narrower scope adds or overrides. | gate: test/practice.test.js | serves: S6
- D2 [draft, must] A repo declines a system rule only with a wont row naming it; no rule drops silently. | gate: test/practice.test.js | serves: D1
- D3 [draft, must] Agents, the context pack and the view see the merged doctrine, each rule labelled with its scope. | gate: test/e2e.test.js | serves: D1

## C · Commits
- C1 [approved, must] Header: type(scope): subject [ids], 72 characters at most. | gate: test/hooks.test.js
- C2 [approved, must] Cited ids exist. feat and fix commits cite at least one. | gate: test/hooks.test.js | serves: S1
- C3 [approved, must] Pre-push runs the gate, unless this exact tree already passed it. | gate: test/e2e.test.js | serves: V4
- C4 [approved, must] Every refusal says what to do and shows what it saw. | gate: test/hooks.test.js | serves: P4
- C5 [approved, must] Pre-commit runs the configured fixers on fully staged files and restages what they fix. | gate: test/e2e.test.js
- C6 [draft, must] Submit refuses unless the item's commits since claim, together, cite every spec row the item cites. | gate: test/e2e.test.js | serves: C2

## R · Receipts
- R1 [approved, must] The ledger lists built items: lane, spec, builder, verifier, verdict, commit. | gate: test/board.test.js
- R2 [approved, must] Every move lands in an append-only event log. | gate: test/board.test.js

## I · Init
- I1 [approved, must] One command sets up config, spec, agent instructions, hooks and board. | gate: test/e2e.test.js
- I2 [approved, must] Init is idempotent and never overwrites a file it did not write. | gate: test/e2e.test.js
- I3 [approved, must] Init writes the standard PRACTICE.md and the role guides as Claude Code skills. | gate: test/e2e.test.js
- I4 [approved, must] `pullboard worktree <lane>` makes a joined worktree and says what to run next. | gate: test/e2e.test.js
- I5 [approved, must] Every command pullboard suggests to an agent starts with cd to its worktree. | gate: test/e2e.test.js | serves: I4
- I6 [approved, must] Init adds a Claude Code SessionStart hook that runs `pullboard resume`, keeping every other setting. | gate: test/e2e.test.js | serves: N19
- I7 [approved, must] `pullboard worktree` prints the opening of a subagent's prompt: its folder, identity, and that AGENTS.md governs. | gate: test/e2e.test.js | serves: I4
- I8 [approved, must] Init registers the project on this machine, so the view lists it. | gate: test/e2e.test.js | serves: N26
- I9 [draft, must] Init ends by telling an agent to start a new session, which loads its skills, then say what to build. | gate: test/e2e.test.js
- I10 [draft, aim] The README draws how work moves, an item's life, where things live and starting with an agent. | gate: test/readme.test.js | serves: M1

## N · Next commands
- N1 [draft, must] `pullboard decide`: the person's queue of everything waiting on them.
- N2 [approved, must] `pullboard next` claims my lane's next free item; --verify names work I did not build. | gate: test/e2e.test.js
- N3 [draft, must] `pullboard context <id>`: frozen bar, cited rows, gates, lane, verdicts, what still blocks it.
- N4 [draft, must] `pullboard ask add` stores the client's documents in ask/, hashed; rows can cite them.
- N5 [draft, must] `pullboard spec approve` and `spec answer` record who changed a row's status, and when.
- N6 [approved, must] `pullboard prompt <role>` prints the role guide, overridable per repo. | gate: test/practice.test.js
- N7 [draft, must] `pullboard plan` proposes lanes and items from the spec and the repo; --apply writes them.
- N8 [draft, must] `pullboard run` starts configured agent commands per lane and role, under budgets and stops.
- N9 [draft, aim] `pullboard report` renders spec coverage, verified items and receipts as one page.
- N10 [approved, aim] `pullboard tour` shows a reject and its rework with scripted agents in thirty seconds. | gate: test/e2e.test.js
- N11 [draft, aim] A git-pullboard bin, so `git pullboard <command>` works.
- N12 [draft, aim] `pullboard mcp` serves the same commands as MCP tools.
- N13 [approved, must] `next` names items still awaiting a verdict; a lane is done when its items are verified. | gate: test/board.test.js | serves: N2
- N14 [approved, must] `pullboard run` builds routed items unattended: pack, agent command, check, retry, then submit or escalate. | gate: test/e2e.test.js | serves: N8
- N15 [approved, must] `pullboard sweep` files a checker's problems as light items, one per file, each checked by that checker. | gate: test/sweep.test.js, test/e2e.test.js
- N16 [approved, must] The runner takes a command per tier and merges an item's verified dependencies before building it. | gate: test/e2e.test.js | serves: N14
- N17 [approved, must] Sweep runs each item's check once before filing; a check that passes on a flagged file is refused. | gate: test/e2e.test.js | serves: N15
- N18 [retired] Model ladders and routing by history left the core for a separate project; the core keeps tiers and escalation.
- N19 [approved, must] `pullboard resume` prints one short card: the claim, the branch against main, what came back, unread shouts, the next step. | gate: test/e2e.test.js
- N20 [approved, must] Within a tier, `next` takes the item sharing most files with the agent's recent work, and names them. | gate: test/board.test.js, test/e2e.test.js | serves: N2
- N21 [approved, must] Submit records the files an item changed; show and the run pack name verified items that share them. | gate: test/board.test.js, test/e2e.test.js
- N22 [approved, must] `pullboard hold <lane>` pauses a lane: nothing new is claimed there, and next says who held it and why. | gate: test/board.test.js, test/e2e.test.js
- N23 [approved, must] `pullboard check [id]` runs an item's check command, yours by default, and prints a digest. | gate: test/e2e.test.js
- N24 [approved, must] Output piped into a reader that stops early, such as head, ends quietly, with no stack trace. | gate: test/e2e.test.js
- N25 [approved, must] Every wait pullboard suggests names its unit and fits one ten-minute tool call. | gate: test/e2e.test.js | serves: N13
- N26 [approved, must] `pullboard view` serves every project's board on localhost, behind a per-session secret. | gate: test/e2e.test.js
- N27 [approved, must] From the view, the person adds items, shouts and holds lanes; each runs the CLI command. | gate: test/e2e.test.js | serves: N26
- N28 [approved, must] The view shows each product's progress: rows met, and items open, building and verified. | gate: test/e2e.test.js | serves: S11
- N29 [draft, must] `pullboard why <path|id>`: the rows, doctrine and verified items behind it, rejections included. | gate: test/e2e.test.js
- N30 [approved, must] `show` prints the latest verdict in full and earlier ones as one line each; --history prints them all. | gate: test/show.test.js
- N31 [draft, must] `pullboard prompt run` and the pullboard-run skill guide one agent through the team: spec, plan, builders, verifier, merges. | gate: test/practice.test.js
- N32 [draft, must] The coordinator's resume names its next step from board and spec: spec, approve, plan, build, verify or merge. | gate: test/e2e.test.js

## H · Hosted
- H1 [pending, aim] `pullboard sync` mirrors the local board to pullboard.dev for teams across machines.
- H2 [pending, aim] Hosted issues an identity per agent, so a verdict binds who gave it, not a path.
