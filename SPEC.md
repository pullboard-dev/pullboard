# Pullboard local

The local-first core of Pullboard: a work board, lanes, a spec and git hooks that live in the repo. No account, no network. This file is the spec, in the format `pullboard spec check` lints.

Statuses: approved = decided · draft = proposed · pending = open question · fact = true today · wont = won't build, decided and kept · retired = no longer applies, kept. Ids are permanent: never delete or renumber a row. Tiers: must · aim.

## P · Principles
- P1 [approved, must] Nothing ships until a second agent verifies it. | gate: test/board.test.js
- P2 [approved, must] Works offline in any git repo, with no account or network unless you turn on sync. | gate: test/e2e.test.js
- P3 [approved, must] Zero runtime dependencies. Node 22.13 or newer. | gate: test/package.test.js
- P4 [approved, must] Every refusal names its rule, shows what it saw, and gives the next step. | gate: review
- P5 [approved, must] The core names no model or vendor, and opens no connection except the sync you turn on. | gate: test/boundary.test.js

## B · Board
- B1 [approved, must] One SQLite file in the git common dir. Every worktree sees it; nothing is committed. | gate: test/e2e.test.js
- B2 [approved, must] Every move is one immediate transaction. Two agents never hold one item. | gate: test/e2e.test.js | serves: P1
- B3 [approved, must] An agent is its worktree. The main checkout is the coordinator. | gate: test/e2e.test.js
- B4 [approved, must] A claim is a lease, 2h by default. Claiming again renews it. | gate: test/board.test.js
- B5 [approved, must] One live claim per agent, besides reworks of its own rejects and child items. | gate: test/board.test.js
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
- B21 [approved, aim] A shout can ask for a decision; it stays open until someone answers it. | gate: test/board.test.js | serves: B7
- B22 [approved, aim] A shout can attach typed evidence: attempt or receipt, outcome, item and commit, as fields, not prose. | gate: test/board.test.js | serves: B7
- B23 [approved, aim] A shout's path:lines@commit reference opens that code as it was at that commit. | gate: test/cockpit.test.js | serves: B7
- B24 [draft, aim] An item can wait on an item in another repo of its project, written repo#id. | gate: test/board.test.js | serves: N33
- B25 [approved, must] Questions go one step up: agents ask their coordinator; a coordinator asks the person or the coordinator above. | gate: test/board.test.js | serves: B21
- B26 [approved, must] Needs-you holds only the person's calls: decisions passed up, rows to approve, held lanes; agents ask their coordinator. | gate: test/board.test.js | serves: B25
- B27 [approved, must] A coordinator answers a decision or passes it up with its note; the answer reaches whoever asked. | gate: test/board.test.js | serves: B25
- B28 [draft, must] Work renews the lease: a commit, gate run or command from the holder's worktree renews its claim. | gate: test/board.test.js | serves: B4
- B29 [draft, must] Every item carries a thread: any agent appends typed facts (capture, measurement, note, diff), and the board stamps each with its author, time and id. | gate: test/board.test.js | serves: B22
- B30 [draft, must] Judgements on an item (decision, rejection, supersession, root cause) come only from its holder or the coordinator. | gate: test/board.test.js | serves: B29
- B31 [draft, must] A thread is append-only: a correction is a new fact that supersedes the old one, and both stay visible. | gate: test/board.test.js | serves: B29
- B32 [draft, must] A fact can bind code as path:lines@sha with the full sha, and show prints the thread and the moves as one timeline. | gate: test/board.test.js | serves: B29
- B33 [draft, aim] The view shows an item's thread in its detail, with code references live. | gate: test/cockpit.test.js | serves: B29

## M · Machine
- M1 [approved, must] One declaration holds every item state, move, guard and refusal; code, help and docs derive from it. | gate: test/machine.test.js
- M2 [approved, must] Every way into a final state passes that state's exit guards, whatever command gets there. | gate: test/machine.test.js | serves: P1
- M3 [approved, must] The board file refuses an undeclared move, and verified without an ACCEPT at the submitted commit. | gate: test/machine.test.js | serves: P1
- M4 [approved, must] A property check proves the declaration: every state reachable, none a trap, every refusal naming a next step. | gate: test/machine.test.js | serves: M1

## V · Verification
- V1 [approved, must] The builder never verifies its own work. | gate: test/board.test.js | serves: P1
- V2 [approved, must] The criterion, title and cited rows freeze at first claim; they alone are the bar, never the brief. | gate: test/board.test.js | serves: P1
- V3 [approved, must] Submit and verify refuse when the frozen criterion or its cited rows changed since claim. | gate: test/e2e.test.js | serves: V2
- V4 [approved, must] Submit needs a clean tree and the gate green at HEAD. | gate: test/e2e.test.js
- V5 [approved, must] ACCEPT needs CRITERION_MET and a note of the proof. REJECT needs a reason code and a note. | gate: test/board.test.js
- V6 [approved, must] REJECT reopens the item. Resubmitting needs a new head. | gate: test/board.test.js
- V7 [approved, must] The verifier's checkout contains the submitted commit. | gate: test/e2e.test.js
- V8 [approved, must] Every verdict binds the submitted commit and the frozen digest. | gate: test/board.test.js
- V9 [approved, must] In the main checkout, verify needs --as coordinator, so no verdict is misfiled as the coordinator's. | gate: test/e2e.test.js | serves: V1
- V10 [approved, must] Agents see a gate digest: one line when green, the failures when red; the full log stays in .git. | gate: test/e2e.test.js | serves: V4
- V11 [retired] Merged into V3: submit and verify both refuse a bar that moved.
- V12 [approved, must] Verify and escalate take --note-file, so a note reaches the board exactly as written. | gate: test/e2e.test.js | serves: V5
- V13 [draft, must] Every verdict records the verifier's HEAD; a review past the submitted commit is flagged, or refused if the repo asks. | gate: test/board.test.js | serves: V8
- V14 [retired] Merged into V2.
- V15 [approved, must] `next --verify` reserves the review under a lease; another verdict on it is refused while the lease lives. | gate: test/machine.test.js | serves: V1
- V16 [approved, must] Submit runs the gate itself on the exact tree it submits, never trusting an earlier stamp. | gate: test/gate.test.js | serves: P1
- V17 [draft, must] Submit refuses a head carrying commits pinned to another item that is not verified. | gate: test/e2e.test.js | serves: V6

## O · Options
- O1 [draft, must] pullboard.json options switch declared guards on or off per repo; show and the view list them. | gate: test/machine.test.js | serves: M1
- O2 [draft, aim] verify.family: off, prefer or require a verifier from a model family that built none of it. | gate: test/board.test.js | serves: V1
- O3 [draft, aim] Agents declare their model family on joining; submissions and verdicts record it. | gate: test/board.test.js | serves: O2
- O4 [retired] Merged into V13.
- O5 [approved, aim] Machine settings in ~/.pullboard hold what belongs to the machine: gate concurrency, run's tier commands, the view's port. | gate: test/settings.test.js
- O6 [approved, aim] Each setting has one home: board rules in the repo, machine capacity and tools in ~/.pullboard; flags override. | gate: test/settings.test.js | serves: O5
- O7 [retired] Merged into Q4.
- O8 [draft, must] Every agent declares the model that runs it; names show it, as web-1 (Claude) or claude-web-1 by option. | gate: test/board.test.js | serves: O3

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
- S8 [approved, must] Commit refuses a deleted row; spec check finds any id once committed or cited, now gone. | gate: test/e2e.test.js, test/spec.test.js
- S9 [approved, must] A wont row stays with its id, out of the counts; nothing new may cite it. | gate: test/spec.test.js
- S10 [approved, must] At an older commit, spec check skips ids that items cite and a later commit added. | gate: test/e2e.test.js | serves: S8
- S11 [approved, must] pullboard.json names products, each a list of spec ids or section letters, as lanes list theirs. | gate: test/products.test.js
- S12 [approved, must] Lanes and items belong to the product of their spec prefixes and cited rows; nothing restates it. | gate: test/products.test.js | serves: S11
- S13 [approved, must] `pullboard spec --json` prints every parsed row, so tools in any language read the spec without parsing it. | gate: test/spec.test.js
- S14 [approved, must] A sign-off can say what the signer checked, with --note, and the note stays with it. | gate: test/spec.test.js | serves: S5
- S15 [approved, must] Signing a row shows the tests and verified items that cite it; a row nothing proves cannot be signed. | gate: test/spec.test.js | serves: S5
- S16 [approved, aim] Each approved row not yet signed shows where it stands on its way to a sign-off. | gate: test/spec.test.js | serves: S5
- S17 [approved, must] Once a repo lists signers, each sign-off carries the signer's SSH signature over the row's exact text. | gate: test/signoff.test.js | serves: S5
- S18 [approved, must] A row can name who must sign it; it is met only when each has a current signed sign-off. | gate: test/signoff.test.js | serves: S17
- S19 [approved, must] spec check refuses a sign-off whose signature fails or whose key isn't listed; a changed row makes it stale. | gate: test/signoff.test.js | serves: S17
- S20 [approved, must] A change to the signer list counts only when a key already on it signs that change. | gate: test/signoff.test.js | serves: S17
- S21 [approved, must] `pullboard spec signers add` sets a repo up with the SSH key the person already uses; no GPG. | gate: test/signoff.test.js | serves: S17

## D · Doctrine
- D1 [draft, must] Pullboard ships a standard doctrine, versioned, with PB ids; every repo inherits it, Pullboard's own included. | gate: test/practice.test.js
- D2 [draft, must] A repo's PRACTICE.md adds rules, overrides one by its PB id, or declines one with a wont row and reason. | gate: test/practice.test.js | serves: D1
- D3 [draft, must] Agents and the view see the merged doctrine, each rule marked standard, with its version, or the repo's. | gate: test/practice.test.js | serves: D1
- D4 [draft, must] Init writes a PRACTICE.md for the repo's own rules only; the standard needs no copy. | gate: test/e2e.test.js | serves: D1
- D5 [draft, aim] `pullboard practice` prints the merged doctrine and what the standard changed since the repo last looked. | gate: test/practice.test.js | serves: D1
- D6 [draft, must] The standard changes only by an accepted RFC in docs/rfcs, and each change bumps its version. | gate: review | serves: D1

## C · Commits
- C1 [approved, must] Header: type(scope): subject [ids], 72 characters at most. | gate: test/hooks.test.js
- C2 [approved, must] Cited ids exist. feat and fix commits cite at least one. | gate: test/hooks.test.js | serves: S1
- C3 [approved, must] Pre-push runs the gate, unless this exact tree already passed it. | gate: test/e2e.test.js | serves: V4
- C4 [retired] Merged into P4, which now also says a refusal shows what it saw.
- C5 [approved, must] Pre-commit runs the configured fixers on fully staged files and restages what they fix. | gate: test/e2e.test.js
- C6 [draft, must] Submit refuses unless the item's commits since claim, together, cite every spec row the item cites. | gate: test/e2e.test.js | serves: C2
- C7 [draft, must] CI runs the gate on every push and pull request, Node 22.13 and 24, on Linux and, once public, macOS. | gate: test/ci.test.js | serves: C3

## R · Receipts
- R1 [approved, must] The ledger lists built items: lane, spec, builder, verifier, verdict, commit. | gate: test/board.test.js
- R2 [approved, must] Every move lands in an append-only event log. | gate: test/board.test.js

## I · Init
- I1 [approved, must] One command sets up config, spec, agent instructions, hooks and board. | gate: test/e2e.test.js
- I2 [approved, must] Init is idempotent and never overwrites a file it did not write. | gate: test/e2e.test.js
- I3 [approved, must] Init writes the standard PRACTICE.md and the role guides as Claude Code skills. | gate: test/e2e.test.js
- I4 [approved, must] `pullboard worktree <lane>` makes a joined worktree and prints its agent's opening lines: folder, identity, AGENTS.md governs. | gate: test/e2e.test.js
- I5 [approved, must] Every command pullboard suggests to an agent starts with cd to its worktree. | gate: test/e2e.test.js | serves: I4
- I6 [approved, must] Init adds a Claude Code SessionStart hook that runs `pullboard resume`, keeping every other setting. | gate: test/e2e.test.js | serves: N19
- I7 [retired] Merged into I4.
- I8 [approved, must] Init registers the project on this machine, so the view lists it. | gate: test/e2e.test.js | serves: N26
- I9 [draft, must] Init ends by telling an agent to start a new session, which loads its skills, then say what to build. | gate: test/e2e.test.js
- I10 [draft, aim] The README draws how work moves, an item's life, where things live and starting with an agent. | gate: test/readme.test.js | serves: M1
- I11 [draft, must] The README shows the board as people see it, captured from a demo board a script rebuilds. | gate: docs/shots/shots.test.js
- I12 [draft, must] The README states what runs where today, which systems are tested, and what comes next. | gate: review
- I13 [draft, aim] A recording of `pullboard tour` plays on the README and the site, regenerated by a script. | gate: docs/shots/shots.test.js
- I14 [draft, aim] A 90-second product video, rendered by a script from the demo board, plays on the README and the site. | gate: docs/shots/shots.test.js | serves: I13
- I15 [draft, must] A release is a tag on a green commit; CI publishes it to npm with provenance, never by hand. | gate: review

## N · Next commands
- N1 [draft, must] `pullboard decide`: the person's queue of everything waiting on them.
- N2 [approved, must] `pullboard next` claims my lane's next free item; --verify names work I did not build. | gate: test/e2e.test.js
- N3 [wont, must] `pullboard context <id>`; pullboard show prints all of it.
- N4 [draft, must] `pullboard ask add` stores the client's documents in ask/, hashed; rows can cite them.
- N5 [draft, must] `pullboard spec approve` and `spec answer` record who changed a row's status, and when.
- N6 [approved, must] `pullboard prompt <role>` prints the role guide, overridable per repo. | gate: test/practice.test.js
- N7 [draft, must] `pullboard plan` proposes lanes and items from the spec and the repo; --apply writes them.
- N8 [draft, must] `pullboard run` starts configured agent commands per lane and role, under budgets and stops.
- N9 [wont, aim] `pullboard report`; spec view, the view's product progress and the ledger cover it.
- N10 [approved, aim] `pullboard tour` shows a reject and its rework with scripted agents in thirty seconds. | gate: test/e2e.test.js
- N11 [draft, aim] A git-pullboard bin, so `git pullboard <command>` works.
- N12 [wont, aim] `pullboard mcp` serves the commands as MCP tools; A9 covers it.
- N13 [approved, must] `next` names items still awaiting a verdict; a lane is done when its items are verified. | gate: test/board.test.js | serves: N2
- N14 [approved, must] `pullboard run` builds routed items unattended: a command per tier, verified dependencies merged, check, retry, submit or escalate. | gate: test/e2e.test.js | serves: N8
- N15 [approved, must] `pullboard sweep` files a checker's problems as light items, one per file, each check seen failing first. | gate: test/sweep.test.js, test/e2e.test.js
- N16 [retired] Merged into N14.
- N17 [retired] Merged into N15.
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
- N33 [draft, must] A repo names its project in pullboard.json, and the view lists projects with their repos beneath. | gate: test/cockpit.test.js | serves: N26
- N34 [draft, must] A project has one Needs-you and one activity feed across its repos; each repo keeps its own board. | gate: test/cockpit.test.js | serves: N33
- N35 [draft, aim] A repo whose folder is gone leaves the view; `pullboard forget <path>` removes one by hand. | gate: test/e2e.test.js | serves: N26
- N36 [draft, aim] The view names each repo as pullboard.json does, falling back to its folder name. | gate: test/cockpit.test.js | serves: N26
- N37 [draft, must] pullboard help keeps each command's usage apart from its words, so tools can read it. | gate: test/e2e.test.js
- N38 [draft, must] Every tab, item, row and shout in the view has its own address, so any of them can be linked. | gate: test/cockpit.test.js | serves: N26
- N39 [draft, must] The view's secret never stays in the address bar: the first link trades it for a cookie. | gate: test/cockpit.test.js | serves: N26

## A · API: the engine others build on
- A1 [approved, must] Every command prints --json in a documented shape, stable within a major version. | gate: test/api.test.js
- A2 [approved, must] `pullboard serve` offers a versioned local HTTP API: the board's state, its moves, and live events. | gate: test/api.test.js
- A3 [approved, must] The view uses that API and nothing else, so any app can do what the view does. | gate: test/api.test.js | serves: A2
- A4 [approved, must] The relay serves the same API, sealed, so a client with the key works the same locally or on pullboard.dev. | gate: test/relay.test.js | serves: A2
- A5 [approved, must] SPEC.md's grammar, the board's schema and its event log are documented, versioned, and upgraded in place. | gate: test/api.test.js
- A6 [approved, must] `pullboard doctor` checks a board's integrity and names how to repair each thing it finds. | gate: test/api.test.js
- A7 [approved, aim] `pullboard export` writes a whole board as JSON, and `import` rebuilds it, losing nothing. | gate: test/api.test.js
- A8 [draft, aim] The gate passes on macOS, Linux and Windows. | gate: test/ci.test.js | serves: C7
- A9 [draft, aim] An agent can work the board through MCP tools, with the same moves and refusals as the CLI. | gate: test/api.test.js
- A10 [draft, aim] The view exports a board as a read-only static snapshot that replays its events, for any static host. | gate: test/cockpit.test.js | serves: A3

## H · Relay: pullboard.dev, opt in
- H1 [approved, must] `pullboard relay on|off` links this board to pullboard.dev, after a GitHub sign-in. | gate: test/relay.test.js
- H2 [approved, aim] With the relay, each agent has its own token, so a verdict records which agent gave it. | gate: test/relay.test.js
- H3 [approved, must] With the relay on, every move passes through it in one order: a claim is won once, everywhere. | gate: test/relay.test.js | serves: H1
- H4 [retired] Merged into H16: clients, not the relay, apply moves in the relay's order.
- H5 [approved, must] Signed in and paired, you see and act on your boards live, on phone or desktop. | gate: test/relay.test.js | serves: N26
- H6 [retired] Merged into H12.
- H7 [approved, must] The relay holds board records, never code; unlinking loses nothing, since the local board stays complete. | gate: test/relay.test.js
- H8 [approved, must] You see and act only on boards of repos your GitHub account can read. | gate: test/relay.test.js
- H9 [approved, aim] An agent that can't push reaches the relay with a token scoped to one board. | gate: test/relay.test.js | serves: H1
- H10 [approved, aim] Offline, a linked board reads locally and refuses moves until the relay answers. | gate: test/relay.test.js | serves: H3
- H11 [draft, aim] Without an account, `pullboard sync` keeps one board across machines through the repo's own git remote. | gate: test/sync.test.js
- H12 [approved, must] pullboard.dev never writes to a repo: what you do there, like approving a row, reaches your agents as a request. | gate: test/relay.test.js | serves: H6
- H13 [draft, must] Acting on a board, and minting its tokens, needs write access to its repo. | gate: test/relay.test.js | serves: H8
- H14 [draft, must] A public repo's board is hidden from readers without triage access, unless its owner publishes it. | gate: test/relay.test.js | serves: H8
- H15 [approved, must] The relay can't read boards: the CLI seals every move and snapshot with a key that stays on your devices. | gate: test/relay.test.js | serves: H7
- H16 [approved, must] Every client applies moves in the relay's order with the CLI's engine, refusing what the CLI refuses. | gate: test/relay.test.js | serves: H3
- H17 [approved, must] A phone or machine joins a board by pairing once, from a code or QR a linked machine prints. | gate: test/relay.test.js | serves: H15
- H18 [approved, must] The relay keeps a board only while linked: unlinking deletes it; 90 idle days delete it; backups last 14 days. | gate: test/relay.test.js | serves: H7

## Q · Queues and procedures
- Q1 [approved, must] A resource has a name, a capacity, a scope (machine, repo or board) and a queue. | gate: test/resources.test.js
- Q2 [approved, must] Taking a full resource queues the taker in order, and it says what it waits behind. | gate: test/resources.test.js | serves: Q1
- Q3 [approved, must] A resource is held under a lease, so a holder that dies frees it when the lease lapses. | gate: test/resources.test.js | serves: Q1
- Q4 [approved, must] Each gate run takes one of its machine's gate slots, two by default; a cached pass takes none. | gate: test/resources.test.js | serves: Q1
- Q5 [draft, aim] Procedures are state machines declared as data: states, moves, actors, guards and resources. | gate: test/procedures.test.js
- Q6 [draft, aim] The item lifecycle runs from its declaration, as the first procedure. | gate: test/procedures.test.js | serves: Q5
- Q7 [draft, aim] Agents raise proposals from friction; another agent reviews the evidence; the coordinator adopts. | gate: test/procedures.test.js | serves: Q5
- Q8 [draft, must] An adopted procedure starts as a draft for the person to approve, and they can suspend it any time. | gate: test/procedures.test.js | serves: Q7
- Q9 [draft, must] spec check refuses a procedure with an unreachable state, a move no actor can make, or a resource cycle. | gate: test/procedures.test.js | serves: Q5
- Q10 [draft, must] Procedures only add structure: they queue, order and guard moves, and never drop a standard guard. | gate: test/procedures.test.js | serves: Q5
- Q11 [draft, aim] A repo option says when a draft procedure runs: at once by default, once approved, or never. | gate: test/procedures.test.js | serves: Q7
