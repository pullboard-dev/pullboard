# Changelog

Notable changes to Pullboard, for people using it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.9.3] - 2026-10-26

Teams and many boards: a board now knows its people and their roles, each repo can keep a private board beside the team board, and every move completes locally at once.

### Added

- The board knows its people: events name who made each move, approvers decide, and moves only a person may make are signed with a passkey tap from any terminal, including over SSH (#343, #408, #1135).
- Every session can read and move: a terminal, SSH, an agent, a job or CI. Each board has one coordinator, passed by takeover across sessions and people (#344, #347).
- A clone of a linked repo joins its board, and a member's device hands over the key. A linked computer goes by the name you give it when linking, and you can pair a second phone or browser with the command the page shows (#342, #978, #1004).
- Each repo can keep a private board beside the team board, and items move between them (#345).
- Boards work across repos: an item can wait on an item in another repo's board, written `repo#id`; `pullboard decisions` lists every open decision across a project's repos; and linked boards pass decisions, item offers and receipts with only the fields you permit (#558, #559, #1245, #1247, #1248).
- Without the relay, two machines share one board through the repo's git remote, and a phone can see and act on a board through the view on your local network (#562, #563, #1226).
- Review independence: an agent's grant narrows to its item at claim, an agent's helpers are recorded under it, a reviewer is refused for any item its session ever built, and a reviewer can withdraw its own accept before the item lands (#348, #800, #1085, #1102, #1143).
- The view opens on whether the rules hold, then on what needs you. Needs you shows agent-approved rows, sentinel drafts and Rigor's automatic drafts with Approve and Decline, each showing the row's full text and check (#965, #967, #1021, #1026, #1150, #1374).
- Agents can propose a change to an approved spec row; it waits in Needs you with the old and new text side by side (#980, #1191).
- When Pullboard blocks something only a person can do, it says so at once with the one step, shows it in Needs you in plain words, and clears it when the move later succeeds (#1022, #1060, #1077).
- A Settings page shows every setting by scope, read-only (#969).
- The README's item-count badge is live: it reads the board's own record and refreshes on every landing (#1061, #1410).
- Decisions record where they came from (you, relayed from you, an agent, inherited), and `pullboard why <file>` lists the decisions behind a file. Decisions have their own queue, so the asker keeps working and the answer lands on the item (#970, #1220).
- `pullboard init` adds light hooks for Claude Code and Codex: resume at session start and a reminder about unsubmitted work at the end. They never block; `init --no-hooks` skips them. An agent can work the whole loop through MCP (#961, #971).
- Pull requests get a "verified by a second agent" status teams can require; a pull request made outside Pullboard shows as not verified. Teams that work in pull requests can have Pullboard open one pull request per release carrying each item's proof, and merging it ships the release. `pullboard intake <PR>` files an outside pull request as an item verified only in a sandbox (#987, #988, #1027).
- `pullboard next` orders the queue itself: unblockers and quick wins first, the focus milestone first when the board names one, longest remaining path first, and never work that collides with work in flight. A seat with no claim is never told to wait. A milestone can carry an item limit and lists its open items first (#1017, #1094, #1114, #1190, #1210, #1239, #1242, #1382).
- Messages go to the item and the people on it, not to everyone. Item conversation is typed notes on the item thread, each agent reads a feed tailored to its work, and the feed splits into interrupts and a digest for natural breaks. Seats report presence (live, idle or gone), and every seat has its own address so agents outside this machine can message it (#994, #1115, #1166, #1167, #1171, #1172).
- Landing runs one batch at a time under the board's lease, never batches two items that touch the same file, tests candidate batches in parallel, resolves machine-resolvable conflicts itself, and prunes merged items' clean worktrees (#417, #418, #1098, #1118, #1177, #1333).
- Registered runners: remove one by name (a busy runner drains first), they use the capacity they were registered with, landing spreads across all of them, and review checks run on them at the exact commit. A test that needs a desktop runs only on a runner with a confirmed logged-in session (#925, #1005, #1066, #1069, #1078, #1134, #1209).
- Architecture blueprints bring their own rules and a check for each one (#998).

### Changed

- Local first: every move completes locally at once, reads never wait on the relay, a move sends one small event instead of the whole board, and the phone shows moves past its last checkpoint as pending (#1013, #1014, #1113).
- Faster: `pullboard status` answers in under 100 ms and an item's detail opens at once on a large board; read commands never take the write lock; submit answers in minutes, leaving a large test selection for landing (#1039, #1040, #1041, #1047, #1048, #1070).
- The view's secret leaves the address bar: the first link trades it for a cookie. `init` and the bare view address send you to app.pullboard.dev (#188, #1019, #1020).
- Only the person can exclude a board from the relay, and you can see the relay's health (#1283, #1289).

### Fixed

- pullboard.dev says when a board is too big to share, and when a board is excluded from sharing and how to include it (#983, #984).
- An old pairing link no longer blocks an already-paired browser, and a removed browser says so instead of showing a blank page, on a computer and on a phone (#981, #982).
- Relinking after `relay off` no longer fails every move, a deleted relay copy relinks, and an offline hand-off keeps its own item number when another machine adds items (#1179, #1183, #1289).
- A refusal after a move was recorded says it was recorded, never to run it again; a GitHub rate limit is named as a rate limit, not lost repository access; a busy board names who holds the lock instead of printing a stack trace (#1023, #1024, #1142, #1197).
- Boards that can no longer be read collapse to one line, and while the board list loads the page never tells a person with boards to run init (#1035, #1104).
- The tab bar fits a 320px screen with the Home tab, and shout cards fit beside a classic scrollbar (#1079, #1083).

## [0.9.2] - 2026-10-21

### Your board catches its own repeats

Pullboard now turns a failure that keeps coming back into a rule with its proof. Rigor runs by itself: it names the files that keep colliding and proposes how to split them, and it carries your code and test quality rules as checks it runs on every change. Its new rules arrive as drafts, and only you approve them. Sentinels watch for something wrong right now: a board holds its own watches, which you approve and which report to their owner, and Rigor can draft one when a check could watch a repeat.

### Added

- The view shows blueprint fit proposals with their reasons, and sentinel drafts for you to approve. (#762, #920)
- `pullboard stats` and `pullboard digest` say what the board caught: work a reviewer sent back and the gap it named, merges that went back instead of landing broken, flaky tests proven, and stuck states. It stays quiet unless someone asks. (#816)
- Pullboard tracks flaky tests, including CI runs: a test that goes red and green on the same tree is filed once with its runs, and can stop blocking landings until its fix is verified (`pullboard flakes quarantine on`, off by default). (#887, #918, #813)
- `pullboard queue` shows the work queue with release breakpoints, rank, route and who holds each item, and `pullboard health` names queue faults: a route nobody serves, an item nobody can take, a rank out of order. (#797, #798)
- A recurring job declares its cadence with `pullboard loop declare`, and a missed run shows in health. (#815)
- Optional two-tier landing: accepted work lands on your local trunk in seconds, and `pullboard publish` pushes only a head the whole suite passed (`landing.publish` set to `separate`; off by default, except that `pullboard init` turns it on in a repo with no remote). (#801, #963)
- A reopened item can wait for its own builder first, for a time you set (`claim.reopenFirstRefusalMinutes`; off by default). (#954)
- A spec row an agent marks approved by hand shows as agent-approved, with the agent and commit, until you confirm or decline it. A setting, `spec.agentApproval`, chooses flag (the default), allow or refuse. (#960)
- `GET /api/v1/settings` reports the board's settings, each with its scope, its value and where it comes from, read-only; secrets show only as set or not set. `spec.agentApproval` joins the list in the next release. (#968)
- `pullboard publish` records each full-suite run, so a flaky test it sees is filed like any other. (#975)

### Safer by default

- A rule cannot lose its test silently: spec check fails when an approved row's gate file was deleted or renamed. (#809)
- The board runs a revert control before it accepts a fix, a gate that rejects everything is an alarm and not a pass, and a check whose pipe hides its exit status is refused. (#810, #811, #812)
- A verdict from the session that built the item is refused, and a change that edits an existing test or gate file says why. (#921, #814)
- Lane branches, merge commits, docs and view files never name your machine or quote you. (#892, #893, #894, #895)

### Your board on your phone

- A board of any size opens on a phone from a small snapshot, then streams its full history while new moves arrive. The relay holds snapshots up to 64 MB, and an account nearing its storage quota is warned before any write is refused. (#903, #946, #949)
- A linked board opens in Safari and other WebKit browsers. (#976)
- A move still succeeds while the relay is down: it waits in an ordered outbox and is sent when the relay is back. A slow or lost relay reply never fails a local move. (#922, #919)
- The hosted page shows a screen right away on iPhone Safari, names the real reason a signed-in browser sees no board with the one step that fixes it, and never flashes another screen first. (#897, #899, #900, #901, #904, #932)
- In Safari, app.pullboard.dev now finds the board running on your computer. (#977)
- pullboard.dev now mentions a board that is waiting for approval on your phone. (#985)

### Fixed

- `pullboard init --yes` never hangs when an agent runs it; a Codex agent whose sandbox cannot write the board gets its one-step fix; an agent can make its first lane without stopping to ask. (#906, #913, #914)
- `pullboard next` never tells a seat it holds another seat's claim, and the MCP `board_status` tool answers on a board with held items. (#958, #974)
- `pullboard next --verify` no longer reserves a review for a seat of the session that built the item. (#973)
- A hung network mount no longer stalls Pullboard. (#912)
- A registered runner's round trip no longer times out under load: each runner call makes 5 git calls instead of about 700, and its timing guards charge each phase only its own time. (#972)
- The tour leaves no demo project behind, links nothing to the relay, and finishes when an agent runs it. (#951, #952)
- `pullboard land` works in a repo with no remote, and `pullboard status` no longer opens with a refusal there. (#963)
- `pullboard init` now prints a short summary and one next step; the details are behind `--verbose`. (#964)

### Upgrade note

- Boards written by this version use the relay's new format, so a joined computer on an older version is asked to upgrade before it can read them; the phone page updates with the relay. (#903)

## [0.9.1] - 2026-10-19

### pullboard.dev opens your board, and pairing just works

Open pullboard.dev on any device and it takes you to your board one clear step at a time. `pullboard init` offers to share the board with your phone in one Enter, and `pullboard view` keeps running in the background, so your phone always has a board to open.

### Added

- Relay and pairing:
  - `pullboard init` offers to share your board with your phone in one Enter.
  - `pullboard view` keeps running in the background.
  - The view links this machine's boards to pullboard.dev in one sign-in, from a card you can close and bring back.
  - Approving a link on your phone delivers the board without another command.
  - `pullboard relay devices` lists phones and joined computers by name.
  - A lost phone can be revoked without that phone's approval.
  - A revoked browser is refused and told it was removed.
  - `pullboard relay on --all` says who signed in, what it linked and what it waits for.
  - The hosted page says how far behind this machine Pullboard is.
- Roadmap:
  - Each milestone sums its items by state, with an estimate at today's pace; on a slow day it estimates from the last 24 hours, or says it's too early to tell.
  - Finished milestones sit under Shipped, and the Roadmap opens on the current release.
  - A blocked item shows a dot and expands in place to say why.
  - `pullboard roadmap` lists the work to ship first.
- Rigor:
  - `pullboard rigor` notices a failure cause that repeats.
  - `pullboard rigor draft` turns a repeated cause into a draft row with its proof, waiting in Needs you.
- `pullboard health` names every stuck item, why it's stuck, and who moves it next.
- `pullboard digest` writes a readable briefing of one board.
- `pullboard gate set "<command>"` sets the project gate in one step. A board without a gate is told that command with the test command Pullboard found (such as `make test`), never a hand edit of pullboard.json.
- `pullboard watch` follows the board's live event stream.
- `pullboard next`:
  - follows the coordinator's ranking inside a release;
  - names the item and the seat to work in across an agent's lanes;
  - in the main checkout, points a newcomer to their lane.
- A newcomer working alone can start their reviewer with one command.
- An agent in a lane worktree can draft a spec row and cite it at once without editing a file outside its lane; every writer takes its row id from one allocator on the board, so two drafts never share an id.
- An item that fails twice at one route moves up a route by itself; at the strongest route it stays with its builder.
- An accepted item that conflicts with the trunk reopens for a main merge with `pullboard reopen <id> --conflict <file>`, and its accept stays recorded.
- A person's waiver also covers the submit and landing gates.
- A ruling the person approves becomes doctrine every agent reads, and a decision names the items it changes.
- A test that escapes to landing is proposed as a submit invariant.
- `pullboard init`:
  - takes a product and an architecture blueprint together;
  - grants the agent the permissions the Pullboard loop needs;
  - commits its own setup files, or offers to in one Enter.
- Blueprints:
  - A blueprint fits the repo before you approve it.
  - Its questions default from the repo they land in.
  - Each rule names its source.
  - Its starter items land in a build lane.

### Changed

- `pullboard submit` runs the static style checks first, in seconds.
- `pullboard init` says the one line that matters first, and folds the rest.
- A board building without spec rows is no longer told to draft the spec first.
- Only test files that start a browser wait for a browser slot, and a short check never waits behind whole suites.
- The gate pool serves the current release first.
- A check that's already green on main holds the item until the person accepts it.
- Agents ask the person only through the coordinator.

### Fixed

- An agent can't mint relay tokens from its worktree.
- Pullboard's git hooks never silently run a different Pullboard version from the one that installed them; a mismatch names both versions and the command that fixes it.
- Pairing again after a device joins isn't refused as busy.
- A joined computer keeps working locally after the relay copy is deleted.
- A relay read survives one reset connection.
- `pullboard resume` and `pullboard health` no longer crash on Node 22.13 with "statement has been finalized" while reading item history.
- A verdict reads stale when main moves under its files, and the view shows a stale chip on it.
- An item claimed before the board had a gate can submit once a gate exists.
- A landing gate that stops early at the first failure keeps that test's own report (its message, expected and actual, and location) in its output and log, and counts it as a failure.
- When the gate goes red on submit, the refusal shows what the gate said, and `pullboard spec check` says to merge main when main already has the cited row.
- A check that isn't valid shell is refused when it's set, and `pullboard gate` with a stray word refuses instead of running.
- A busy view port names the program holding it, with a fix the hosted page can still find.
- The view catches up with what changed instead of re-reading the board, and an unchanged board doesn't redraw.
- A row detail no longer repeats who approves rows.
- An approval whose row's gate or tier changed afterward shows as stale on every surface, in the view and the CLI, and asks you to approve the row again.
- On a board with no approved spec rows, a feature commit is told a path that works: draft the row and cite its id at once, while the person approves it. The format example in SPEC.md is never read as a row.
- An approved row that isn't applied yet names `pullboard spec apply`, and pending questions name `pullboard spec answer`.
- `pullboard worktree` suggests an install only when the project has dependencies.
- `pullboard init` in a repo without package.json finds the test command for its stack, or asks for one, instead of leaving it without a gate.
- A sandbox denial inside a child process still reads as sandbox blocked, and a view a sandbox can't bind says how to allow it.
- A review waiting in the gate pool keeps its lease.
- The relay link in the invitation has a 44px tap target on phones.

## [0.9.0] - 2026-10-16

### Open your board from pullboard.dev

pullboard.dev now lists the boards on this machine beside your linked boards, so one page opens all of them. Link every board once with `pullboard relay on --all`, pair your phone from the QR it prints, and open pullboard.dev on any device.

### Added

- pullboard.dev lists the boards on this machine together with the boards you linked, and opens either kind.
- The phone page can be installed to your Home Screen, and it asks the browser to keep its storage, so a paired phone stays paired.
- `pullboard lane add <lane> --owns <path>` makes a lane, and `pullboard init` proposes lanes for the folders it finds.
- A Doctrine rule can carry a check and a `count:` that only falls: `pullboard submit` refuses a change that makes a touched rule's count rise.
- With `landingShards` in `pullboard.json`, the landing gate splits its tests into shards that run in parallel, locally or on registered runners.
- Machine settings, all off unless you set them:
  - `gate.queue.reviewsFirst`: the gate pool admits reviews before submits, with `gate.queue.agingMinutes` bounding every wait.
  - `gate.memoryFloorMB`: the gate pool holds new work while free memory is under the floor, and names the biggest processes.
- Every bundled blueprint's starter items carry a criterion and a check, so the first item can be built and verified.
- `pullboard spec answer <id> "<choice or text>"` records your answer to a pending blueprint question, from your terminal or the view. An agent is refused.
- `pullboard init` puts new agent worktrees inside the repository, in `.claude/worktrees`. Boards without the setting keep them beside it; set `"worktrees": "beside"` in `pullboard.json` to choose.

### Fixed

- `pullboard accept` says how to land the item, and `pullboard land --dry-run` catches a missing origin.
- A gate blocked by an agent's sandbox stops with `SANDBOX_BLOCKED`, asks the person, and names any test file the agent edited.
- A waiver given after a gate stopped early runs the gate again.
- The view loads an item's full detail only when you open it.
- The page's Needs-you list comes from one place, so the panel, the list and the counts agree.
- `pullboard resume` on a board it cannot write refuses by name, with the step to fix it.
- `pullboard resume` names `pullboard lane add` instead of a script.
- A person move is refused from a remote SSH shell whichever SSH variable the shell carries.
- `pullboard blueprint save` reads back a question with three or more choices.

## [0.8.29] - 2026-10-16

### Blueprints, MCP, and refusals that tell you what to do next

0.8.28 never reached npm: one runner test hung on Linux CI, and that's fixed here. Everything listed under 0.8.28 in the changelog ships in this release too.

### Added

- Blueprints.
  - `pullboard blueprint add <name>` files a blueprint's rules as draft spec rows for your approval, with its starter items.
  - `pullboard init --blueprint <name>` starts a new board from one.
  - `pullboard blueprint save` turns your board's approved rules into a blueprint you can reuse.
  - The ten blueprints from the gallery are bundled.
- `pullboard mcp`: an MCP server over stdio. An agent's own client can read the board and coordinate on it: board status, show an item, shout, capture an idea. It uses the same moves and refusals as the CLI, and it can never act as the person.
- `pullboard runner add <host> --slots <n> --browser <n>`: a test run waiting in the gate pool can run on another machine over SSH. A runner uses its own machine's browser slots. Nothing changes unless you add a runner.
- `submitInvariants` in `pullboard.json`: with `"submitGate": "landing"`, `pullboard submit` still runs these test files on every submit.
- The Roadmap shows the work to ship first, with shipped work below it.

### Fixed

- Every refusal ends with a next step that works.
- `pullboard init` says when the gate command it found can't run on this machine. In an existing repo, the first gate after `init` says to commit the files `init` wrote. `pullboard init --help` lists `--blueprint`.
- `pullboard worktree <lane>` from the main checkout creates and joins the worktree for the session that owns the checkout. Another session is still refused. Without a model, it names the `--model` flag to add.
- `pullboard add` refuses a build item in a lane that owns no files and names the lanes that do. A review item that names the work it reviews (`--after <id>`) is still accepted.
- When `~/.pullboard` can't be written, for example inside an agent's sandbox, commands refuse with `MACHINE_HOME_NOT_WRITABLE`, name the folder and say how to fix it.
- A declined spec row keeps its text, and the view shows the reason it was declined.
- A relay connection failure names its cause.
- The API refuses blank shout text the same way the CLI does.
- The README's worktree command includes `--model`.

## [0.8.28] - 2026-10-16

### Blueprints, and a first run that tells you what to do

### Added

- Blueprints. `pullboard blueprint add <name>` files a blueprint's rules as draft spec rows for your approval, with its starter items. `pullboard init --blueprint <name>` starts a new board from one. `pullboard blueprint save` turns your board's approved rules into a blueprint you can reuse. The ten blueprints from the gallery are bundled.
- `pullboard runner add <host> --slots <n> --browser <n>`: a test run waiting in the gate pool can run on another machine over SSH. Nothing changes unless you add a runner.
- `submitInvariants` in `pullboard.json`: with `"submitGate": "landing"`, `pullboard submit` still runs these test files on every submit.
- The Roadmap shows the work to ship first, with shipped work below it.

### Fixed

- `pullboard init` says when the gate command it found cannot run on this machine, and how to fix it. In an existing repo, the first gate after `init` says to commit the files `init` wrote.
- `pullboard worktree <lane>` run from the main checkout creates and joins the worktree for the session that owns the checkout, and another session is still refused. Without a model it names the `--model` flag to add.
- `pullboard add` refuses a build item in a lane that owns no files and names the lanes that do. A review item that names the work it reviews (`--after <id>`) is still accepted.
- When `~/.pullboard` cannot be written (for example inside an agent's sandbox), commands refuse with `MACHINE_HOME_NOT_WRITABLE`, name the folder and say how to fix it, instead of SQLite's "unable to open database file".
- A declined spec row keeps its text.
- A relay connection failure names its cause.
- The README's worktree command includes `--model`.

## [0.8.27] - 2026-10-16

### A faster gate, and 0.8.26 reaches npm

0.8.26 was tagged but never reached npm (its publish check refused a Node 22.13 test failure, fixed here). Everything in [0.8.26](https://github.com/pullboard-dev/pullboard/releases/tag/v0.8.26) ships in this release too.

### Added

- `"submitGate": "landing"` in `pullboard.json`: `pullboard submit` runs the item's check and the tests for the files you changed, and the whole suite runs once, at `pullboard gate --landing`. Off unless you set it.
- `pullboard settings browserSlots <n>` runs up to that many real-browser test runs at once (default 1, at most `gateSlots`).
- The machine setting `gate.browserFreeChecks`: a check Pullboard can prove needs no browser skips the browser queue. Off unless you set it.
- `pullboard relay on` works from an SSH shell; you confirm the link in your browser.

### Fixed

- `pullboard view --project` keeps the local server to that project too: no page or API answer names another project.
- Opening an item's detail after a cache miss starts no git process.
- For contributors: the landing gate's early stop works on Node 22.13, and the one-project view test waits for its project before reading the page.

## [0.8.26] - 2026-10-15

### One-project views, and linking you can cancel

### Added

- `pullboard view --project`, run inside a registered project's repository or one of its worktrees, opens a view of that project only: the boards list, each board and the roadmap show nothing from your other projects.
- `pullboard gate --landing` now sets `PULLBOARD_LANDING_RUN=1` for your gate command, so your test runner can stop at its first failing file. See docs/api.md.

### Fixed

- Linking every board on this machine (`pullboard relay on --all`) can be cancelled. Declining or closing the sign-in links nothing and leaves nothing behind; a cancel during pairing keeps the boards already linked and stops pairing cleanly.
- A browser that refuses storage keeps an early board pairing in memory until the page uses it.
- For contributors: a red landing gate stops at its first failing test file (on Node 22.13 it still runs every file, as before; fixed in the next release); a check that needs no browser never waits for the browser slot; and a stress board with a harness times every view action, outside the suite.

## [0.8.25] - 2026-10-15

### Project switches you can trust, and a 98-second explainer

New on [pullboard.dev](https://pullboard.dev): a 98-second explainer video on the home page, showing some of the problems Pullboard addresses.

### Fixed

- Switching projects in the view never shows the previous project's numbers under the new project's name. The project list appears at once, and the new project's counts read as loading until they arrive.
- `pullboard spec draft` never reuses an id that SPEC.md already has, including ids that DOCTRINE.md uses.
- For contributors: the landing gate bounds its own concurrency (at most two real-Chrome test files at once, and no more test files at once than the machine has performance cores), so it no longer fails from its own load; the test runner runs only files named `*.test.js` or `*.test.mjs`, so fixtures and the view's performance harness no longer start as test files; the README capture follows the view's cookie redirect and is ready from what the page shows; and the repeated-read test goes through the view cookie.

## [0.8.24] - 2026-10-15

### A first board without surprises

Fixes from a newcomer's first board: setup tells you what it's waiting on, spec drafts go where you put them, and a fresh repo's errors name the real cause.

### Changed

- `pullboard spec draft --section <letter>` files the row in that section with its next free id. An unknown section is refused with the list of sections that exist. Goals (G) stays the default.
- After the setup rows are drafted, `pullboard resume` says setup is waiting on you to approve them, names the rows, and says what the agent can do meanwhile. Before, it kept saying "step 1, next: spec draft".
- For coordinators: after you reopen a submission to correct its bar, the builder can resubmit the same commit against the corrected bar. A rejected item still needs new work.

### Fixed

- A session in a worktree whose main checkout has uncommitted setup files is told exactly that, with the `git add` line to run in the main checkout. Before, every command refused with NO_CONFIG.
- `pullboard gate` in a fresh repo before the first commit says pullboard.json isn't committed and gives the `git add` line, instead of a NO_POLICY error about a missing policy.
- The view's cookie is honored only for requests from the view's own page. A request from another local port or site is refused, and a cookie with too little randomness is refused at startup.
- For contributors: relay storage tests pass under any umask, and the pointer-refresh test holds under landing-gate load.

## [0.8.23] - 2026-10-15

### Faster reads, and your approvals stay on their board

A repeated read starts no processes, "Approve all" and declines happen in the page and stay on the board they were opened on, and agents' heavy test runs queue on their own.

### Changed

- Reading the view no longer starts git or node processes once it's warm. On a 600-item board over a tunnel, the board list went from about 70 ms to about 12 ms and a board's state from about 240 ms to about 135 ms.
- "Approve all" in a Spec section asks for confirmation in the page instead of the browser's confirm dialog. It records every row it names, or shows why it didn't.
- A drafted spec row reads as a draft, not as an open question.
- An agent's messages and reads go out while its own submit is running, so it can tell others it's testing instead of going silent for the whole run.
- For teams running agents: every test run on a machine, reviews and browser runs included, waits in the gate pool. Landing goes first, then first come, first served, so nobody has to hand turns over by message. A focused run takes a slot too, so the pool shows it.

### Fixed

- The "Approve all" confirmation and the decline dialog are bound to the board they were opened on. Switching board or project, going back or forward, or a refresh that moves to another board closes them without recording anything, and focus stays inside them while they're open. Before, two boards with the same row ids could get your approval or decline on the wrong one.
- For contributors: tests no longer need port 4890 free, so a running view doesn't break the gate; a test that starts the CLI is selected by what the CLI imports; and tests that hold a capture also hold the page's live updates.

## [0.8.22] - 2026-10-14

### The view follows the board, and reads stay fast

The view no longer re-reads the whole board every few seconds, and a change no longer makes the server rebuild every item.

### Changed

- The view loads the board once, then follows its event stream and catches up on each change. It no longer re-reads the whole board every 3 seconds (about 6 MB on a 600-item board). If the stream drops it reconnects and says so, and after an upgrade the page reloads into the new version.
- One move recomputes only the items it touched. State and item reads no longer wait while the server rebuilds every item after each change, which took 2 to 3 seconds on a 600-item board while agents worked.
- For contributors: a change to a doc runs only the tests that read it at submit, not the whole suite.

## [0.8.21] - 2026-10-14

### One stream for many boards, and the local API never speaks for you

A project group can follow every board on one connection, and nothing sent through pullboard serve counts as you.

### Changed

- One event stream serves many boards: GET /api/v1/events?boards=<id>,<id> sends the events of every named board the caller may read on one connection, each tagged with its board, and resumes per board from Last-Event-ID. A browser's six-connection limit no longer starves a view of a project with several repos.
- The local API can accept the view's session cookie as well as its key, ready for the view to take the key out of the address bar in a later release.

### Fixed

- A request to the coordinator sent through pullboard serve is no longer recorded as yours. Like the other person-only moves, it is refused there; the view's own page still sends your requests as you.

## [0.8.20] - 2026-10-14

### A lighter board, and the local API can't speak for you

The board now answers with item summaries instead of every item's full history, a client can ask for only what changed, and nothing sent through the local API counts as you.

### Changed

- pullboard serve sends item summaries. On a board of 595 items the state is about 581 KB instead of 6.4 MB. GET /api/v1/boards/:board/items/:id returns one item's full detail, GET /api/v1/boards/:board/items?q=<text> searches, and GET .../state?detail=full still returns everything. A sent-back item's summary carries the first line of its reject note.
- GET /api/v1/boards/:board/state?since=N returns only what changed after event N; with nothing changed it is about 23 KB.
- The event stream sends a "changed" event when the board changes without a move: an edit to SPEC.md, DOCTRINE.md or pullboard.json, a new commit, a claim or review expiring, a move on a board the roadmap reads, or a change to what you have seen.

### Fixed

- Moves sent through pullboard serve no longer carry the person's channel, so an agent can't approve rows, answer your decisions or sign off through the local API. The view's own page is unchanged.
- After an action, the view no longer scrolls again when a late refresh arrives, so the next button stays under your pointer.

## [0.8.19] - 2026-10-14

### A faster view, and a red landing hands work back

The view answers an unchanged board in about 40 ms instead of more than a second, and a verified item whose landing gate goes red returns to its builder instead of needing a new item.

### Added

- When a landing gate is red, the coordinator returns a verified, unmerged item to its builder with pullboard reopen <id> --note "<test file>: <test name>; merge commit <sha>", and pullboard land does the same for a red batch. The accept stays in the item's history, and the item needs a fresh accept.
- pullboard edit <id> --after changes an item's dependencies after it is filed.

### Changed

- The view keeps the last board state it built and reuses it until something it depends on changes. On a board of 550 items, an unchanged refresh went from about 1.5 s to about 40 ms.
- A red submit's comparisons with main take the lowest priority and at most one gate slot, so other agents' gates and checks go first.
- Reopening a verified item and editing dependencies are engine 10 moves. A board that uses them needs 0.8.19 on every machine that shares it; an older version refuses those moves instead of reading them differently.

### Fixed

- pullboard view --export no longer fails when a connection closes before its first write; if the view can't be reached, it says so and asks you to retry.

## [0.8.18] - 2026-10-14

### The board stays safe

Removing someone's write access on GitHub now stops their agents as well as them. A red submit no longer holds up the agent that made it.

### Fixed

- When a person loses write access to the repository, moves their agents make on a relay board are refused, as the person's own moves already were.
- Agent credentials from a different GitHub account are discarded instead of reused.
- While a red submit compares its failures with main, the same agent's shouts, facts and reads go through instead of waiting behind it, and the failed tests rerun side by side instead of one file at a time.

### Changed

- An item may carry files that came from its dependencies' own verified dependencies, not only from its direct dependencies.

## [0.8.17] - 2026-10-14

### An agent sets it up alone

Tell your agent "install Pullboard and set it up here". It runs init, carries on in the same session, and walks you through setup. A board with no build to prove, such as research or writing, still gets a gate.

### Added

- During setup, a board with no detected build is offered pullboard spec check as its gate, so setup can finish.

### Changed

- When an agent runs pullboard init, it is told to continue setup in the same session with pullboard resume. A person at a terminal still sees the new-session note.
- Init's last line says what it is for: "To commit Pullboard's files: git add -f -- …".
- The README's setup starts with the one sentence to give your agent; running it yourself is the second path.

## [0.8.16] - 2026-10-13

### Steadier views

pullboard view now has one address on your machine, and running it again reuses the view that is already open. On Node 24 it no longer stalls or crashes.

### Changed

- pullboard view listens on 127.0.0.1:4890 by default, and running it again reuses the view already there for every board on this machine. --port 0 still picks a free port, and --port N still wins.
- If another program holds port 4890, pullboard view says so and suggests --port.
- Setup's last step completes when your agent reuses a view that is already running.

### Fixed

- On Node 24, a connection that closes at the wrong moment no longer crashes pullboard view or its check for a running view.
- The note about what is new after an upgrade no longer stalls the view on Node 24.
- Opening a shout from its link no longer changes the card's layout.

## [0.8.15] - 2026-10-13

### Setup without snags

Your agent can now record your first requirements in one command, gets its terminal back when it opens the view, and help names every spec command and who runs it.

### Added

- pullboard spec draft "<text>" adds a pending requirement with the next free id, and setup names it as the way to record your answers.

### Changed

- pullboard help spec lists every spec command and says which are yours and which are the coordinator's.
- An agent that starts pullboard view gets the link and its terminal back; a person at a terminal still runs it in the foreground.

### Fixed

- Submitting a change to a test now also runs the checks that scan every test file, so they no longer fail only after landing.

## [0.8.14] - 2026-10-13

### Your agent sets it up

Run pullboard init, then ask your agent to set up Pullboard here. Whatever model it is, it now walks you through what you are building, your lanes, the command that proves the build, your first item, and opening the view.

### Added

- On a board that is not set up yet, pullboard resume walks any agent through setup one step at a time, phrased as what to ask you, and each step completes from the board's real state.
- pullboard init ends with one plain instruction, and the agent guide it writes starts with what to do on a new board.

### Fixed

- Pullboard's own tests no longer fail when Chrome still lists a tab it just closed, so its CI is green on Linux and macOS.

## [0.8.13] - 2026-10-12

### Replays hold still

A shared replay's Pause button stays where it is while you press it, and Pullboard's own checks now hold on Linux and macOS under load.

### Fixed

- In a static export's replay, the Pause button no longer shifts under your pointer as the replay runs, so a press lands on it.
- Pullboard's own tests keep waiting through a page navigation, run the three-replica relay check as two tests that each fit their time, and name the startup step when the local server is slow to start.

## [0.8.12] - 2026-10-12

### Your answer always lands

An answer you send in Pullboard View is recorded as your answer, even while your previous shout is still sending.

### Fixed

- Answering a question while your previous shout was still sending could drop your answer, or record it as a plain shout instead of your answer. The earlier send no longer clears what you wrote next.
- The replay controls stay in place at phone width when a scrollbar appears at the end of a replay.
- Tests that waited too long on a busy machine now say which step they were waiting on, and the hook-read lock test holds on macOS.

## [0.8.11] - 2026-10-12

### A proper first visit, safer releases

A brand-new project opens on a calm board, not a list of decisions, and a release can no longer publish anything main's CI did not pass.

### Changed

- On a new project, Pullboard View shows the starter house rules as defaults to review, not as decisions waiting for you. The tour's board is listed and marked demo, and New item defaults to the first building lane.
- The gate runs only the test files git tracks, so scratch copies and agent worktree folders in your repo can no longer fail it.
- A tagged release publishes to npm only when main's CI already passed that exact commit.

## [0.8.10] - 2026-10-11

### Accumulated judgement

The README now opens with what Pullboard is for: accumulated judgement for agents, and a figure of how it holds.

### Fixed

- A board read that still cannot get through after waiting says which board it was, that another process held it, and how long it waited, instead of a bare "database is locked".

## [0.8.9] - 2026-10-11

### 0.8.8 reaches npm

0.8.8 was tagged but never published: its publish gate failed when a git hook read the board while another process was writing it. 0.8.9 is everything in 0.8.8, plus that fix and a few more from the same night.

### Fixed

- A git hook that reads the board waits for another process to finish writing, up to the same ten seconds every other board connection waits, instead of failing at once with "database is locked".
- A request from your phone never moves the row you are reading in Pullboard View.
- An action only you may take, tried from an agent's terminal, is refused at once with "send it from the paired phone", even when the relay is slow to answer.

## [0.8.8] - 2026-10-11

Tagged but never published to npm; everything below ships in 0.8.9.

### Steadier CI, safer boards

A worktree's unmerged code can no longer upgrade the board everyone shares, from the CLI or from Pullboard View. CI now runs in shards and drops runs a newer push has replaced, and the clicks it caught going missing under load now land.

### Added

- A rejected commit can be submitted again, unchanged, after the coordinator corrects its bar and the builder refreezes it. This is engine 9: upgrade every linked device before using it.
- Through the relay, a shout's address opens even a shout older than the forty most recent.

### Changed

- CI splits each run into shards and cancels a run on main once a newer push replaces it.
- The README's board shots are retaken from the current view.

### Fixed

- An agent's worktree running newer code never migrates the shared board or its event log, and Pullboard View's server opens boards through the same guard.
- Item links work everywhere an item is named, and an exported snapshot keeps its addresses.
- Verdict notes keep their line breaks, and code in them stays literal.
- The Lanes panel stays inside its card at every width, including the Hold a lane form.
- A click on an item in the Pipeline view opens it even while the view redraws.
- The Spec tab's decline button keeps working through a refresh.
- The replay controls stay in place when a replay starts.

## [0.8.7] - 2026-10-11

### What you see first

Pullboard View opens on your work. The Items tab leads with your list, with the board's stats in one line above it. The Roadmap leads with the next release, keeps every upcoming one open, and has a panel for moving between them. Every tab, item, row and shout now has an address you can share, reload and come back to.

### Added

- Every tab, item, Spec row, Doctrine row and shout in Pullboard View has its own address. Open it directly, go back and forward, or reload and stay where you were.
- The Roadmap has a panel on the right that jumps to each release and shows how much of the next one is open, building, in review and done.
- `pullboard resume` says what is new since the checkout last ran, once for each release, and `resume --json` carries the same notes as `whatsNew`.
- The coordinator and every agent on the demo board declare their model.

### Changed

- The Items tab opens on the work. The stats take one line above the list, and that line opens and folds the full card. Times read like "3 h 34 min", and the card no longer lists every agent.
- `pullboard stats`, its JSON and the coordinator's resume give times in hours and minutes, and name at most three items before "+N more".
- The Items toolbar is one row: List or Pipeline, a Filter menu for what to show and which lane, and New item.
- The Roadmap leads with the next release and keeps every upcoming release open. Shipped releases fold away.
- Doctrine and Spec rows read like Items rows: two lines, with the full rule a click away.
- The README's board shots show the stats line, and its "What's next" lists only work that isn't built yet.
- The shipped skills teach every command in `pullboard help`, and a test keeps a new command from shipping untaught.

### Fixed

- Rows added in the same second list newest first, even when a commit lands while the view is reading.
- A late transport call is no longer counted as a refused write.

## [0.8.6] - 2026-10-11

### See the flow

Pullboard now tells you where work is waiting. The stats card and the coordinator's resume name the bottleneck and what would fix it, and a Pipeline view shows every item's stage at a glance.

### Added

- Pullboard View shows a stats card: the numbers `pullboard stats` reports, each stage's average time, each queue's size and oldest item, and the bottleneck with its recommended action, all read from the board.
- The Items tab has a Pipeline view: every item laid out by stage as one flow, with its own address.
- The agents panel lists each agent's credential without ever showing it, and revokes one from your paired phone.
- The pullboard-run skill has the coordinator tell you about a bottleneck in one sentence, asking for a decision only when the fix needs you.

### Changed

- When a submit's gate is red, it now says whether main shares the red. An inherited red names the spec row and the open item that owns it, and `pullboard next` offers that item first.
- The README shows the current board, with a screenshot of the Shouts tab.

### Fixed

- A sent-back reason reads once on Items rows and verdict cards.
- The stats card's counts agree in number ("1 agent", not "1 agents").

## [0.8.5] - 2026-10-10

### A prettier board

Pullboard View got a full design pass, so the board is cleaner and easier on the eyes. It's quicker to read at a glance, with what needs you up top and search in the top bar. It works in light or dark and feels right on a phone.

### Added

- `pullboard stats` measures the flow from the event log: build, review wait, review and merge wait times, each queue's size and oldest item, items added and merged per day, resubmits per merged item, and active agents by role and lane. It names the bottleneck and one recommended action.
- The coordinator's `pullboard resume` ends with one line when review backs up (average wait over an hour, or a submission unreviewed for three hours), naming the bottleneck and what would fix it.
- Every agent declares its model when it joins (`--model` or `PULLBOARD_MODEL`), and Pullboard View shows each agent with its model.
- The coordinator can return a submission without a verdict to fix its criterion: `pullboard reopen <id> --note "why"`.
- The coordinator can correct a claimed item's criterion or check without the holder releasing it; the holder adopts the correction with `pullboard refreeze <id>` and keeps its claim.
- `pullboard land` merges verified items in verdict order, gates the batch once, bisects a red to its culprit, and lands nothing on a flake until the test is fixed or you waive it.

### Changed

- `pullboard next` offers work in roadmap order, the next release first.
- `submit` refuses work stacked on an unverified item; `merged` refuses a commit that doesn't carry the item's work.
- Gate slots are machine-wide even with a private Pullboard home, and every full test run takes one.
- Every gate run records where its time went.
- `doctor` and `resume` say when the repo's hooks aren't wired.
- A repo's skills follow Pullboard upgrades and never replace ones you edited.
- Boards use engine 8. Upgrade every linked device; a 0.8.4 device stops at the first new record and says to upgrade.

### Fixed

- An expired relay sign-in never blocks local work, and `relay off` stays off.
- No single agent token can halt relay replay for good.
- `refreeze` picks up a lane change made after the claim.
- Claiming an item whose spec rows are on main but not yet in your worktree fast-forwards a clean worktree, or refuses with SPEC_BEHIND_MAIN naming the rows and the merge to run, instead of a confusing UNKNOWN_SPEC.
- Help examples carry every flag their command requires.

## [0.8.4] - 2026-10-10

### Added

- The coordinator can hold an item: `pullboard hold <id> "reason"` keeps it out of `next` and `claim` on every device until `pullboard hold <id> --off`.

### Changed

- Pullboard View: the Shouts tab's agents panel is compact. Each agent holding work is one row with its avatar, the age of its latest move and the first thing it holds; idle agents are small pills; lane and route show on hover. Pick an agent to filter the feed and address the composer to it.
- Each of your shouts says who has heard it: "Heard by coordinator", "Heard by coordinator and N agents", or "Not heard yet".
- The composer sends to the coordinator, with no recipient picker; a picked agent shows as a chip you can clear.
- A code reference on its own line in a shout, and every one in an item's thread, opens as a block, collapsed until asked, with the exact lines from that commit highlighted; one inside a sentence stays a short label that opens the same block.
- Boards use engine 7. Upgrade every linked device; a 0.8.3 device stops at the first new record and says to upgrade.

### Fixed

- A person-level relay action the relay refuses now fails at once, naming the refusal, its reason and the request id, instead of waiting for a phone card that never comes. A step that half succeeds (the local unlink done, the remote delete refused) exits nonzero and says which part failed.

## [0.8.3] - 2026-10-10

### Changed

- Agents can never act as you on the relay. `relay on` gives each machine its own credential that only mints agent tokens for its linked boards, so agents keep working with no tap, and no file on the machine can act as you. A person-level action from the Mac asks for one tap on your paired phone; the grant is used once and never stored.
- Boards use engine 6. Upgrade every linked device: once a machine on a board has its own credential, older clients on that board stop and say to upgrade.
- Relay snapshots are compressed inside the seal, so a large board syncs.
- Pullboard View: shouts read as cards, with an avatar, name and chips, and decisions and receipts set apart. You shout from a composer, and an agents panel shows who is holding what.

### Fixed

- A refused relay upload never blocks board moves: agents keep working, and each move prints one line saying why.
- A board with no snapshot yet waits on the phone instead of reloading in a loop.
- A recovered relay snapshot clears its stale timeout notice.

## [0.8.2] - 2026-10-09

### Added

- `pullboard relay on --all` sets up the relay once: it links every board on the machine, links boards registered later on its own, and one phone pairing opens all of them.
- Another machine joins a linked board by pairing.
- Each agent has its own relay token.
- From the relay page you can act on your board through sealed requests, and Pullboard View shows each one as waiting, done or refused.
- An item's detail shows its check baseline and warns when the check proves nothing.

### Changed

- Commands ask git each question once, so they run about 4x faster.
- Submit can run only the tests a change affects: set `affectedTests` in pullboard.json to the command that runs selected test files. Without it, submit runs your gate in full.
- A piped gate fails when any stage fails, so a red test piped to `tail` can't read green.
- `pullboard add` returns at once; a check's baseline runs in the background (`--wait` waits for it).
- A review released without a verdict goes to another reviewer, and needs a one-line `--note`.
- Boards use engine 5. Upgrade every linked device; an older client stops at the first new record and says to upgrade.
- Item checks and verify runs wait for a machine gate slot, and a waiting gate goes first.
- A checkout speaks for one agent session.
- A red check at verify shows why it failed.
- Duplicate ids across SPEC.md and DOCTRINE.md are refused; ones PRACTICE.md already had stay warnings after the rename.
- Lane checks can't be bypassed by unstaged config, auto-merges or grafts.

### Fixed

- `pullboard relay on` works over SSH: relay keys live in an owner-only file, not the system keychain.
- Without its board key, a device still reads its linked board locally.
- A registered board behind an unreadable folder stays listed, with one warning.
- `spec check` works in a detached checkout.
- A shell reached over SSH is never treated as your terminal.
- `pullboard edit` on an item whose claim expired reopens it instead of crashing.
- `init` ignores agent worktrees under .claude, so they never block submit.
- A note in a brief's Files entry no longer trips the lane check.
- Pullboard View: only a command becomes a code chip and it stays inline, briefs show their lists as lists, the page never scrolls sideways on a phone, the project list folds into the tab bar on a laptop, and Activity says what each shout said.
- The coordinator's resume is a full handoff brief.

## [0.8.1] - 2026-10-09

### Added

- Your board on your phone: pullboard.dev shows Pullboard View to a signed-in person, and what you do there reaches your board as a request.
- Approve or decline proposed spec rows from the Spec tab, one at a time or a whole section at once.
- An item's detail shows its thread as one timeline.
- `pullboard stats` prints the board's proof numbers.
- The tour's demo board appears in Pullboard View.

### Changed

- The agents' house rules are DOCTRINE.md everywhere; a PRACTICE.md is still read under its old name.
- Submit and accept refuse work that can't merge onto the trunk.
- Accept installs the repo's dependencies before the frozen check, and every accept records whether a check ran.
- Only `pullboard answer` closes a decision, over the relay too.
- A replayed verify obeys the item's frozen policy.
- Every relay client declares its engine, and the relay refuses clients too old to judge agent moves; upgrade every linked device to 0.8.1.
- Offline, a linked board reads locally and refuses moves.

### Fixed

- Retrying a move after a lost reply never duplicates it.
- Merging main into a lane branch commits cleanly; edits outside the lane are still refused.
- Test runs keep a private machine home, so they no longer add projects to Pullboard View.
- Chrome and port tests hold up on a busy machine.

## [0.8.0] - 2026-10-08

### Added

- Pullboard View has a Roadmap tab for milestones, item status, progress and notes; `/roadmap` opens it directly.
- Any agent can add a typed item fact; only its holder or the coordinator can add a judgement, and a correction leaves the old fact visible.
- `--ref path:lines@sha` binds a code reference to a full commit, and `pullboard show` prints moves and facts in one timeline.

### Changed

- Repositories can use any trunk branch name, including `master` or `trunk`.
- Every device checks sealed moves against the signed-in sender, so an agent cannot act as the coordinator or person.
- Relay engine version 3 stops replay at a newer engine record; upgrade every linked device to 0.8.0.

### Fixed

- Chrome tests wait for the page elements they measure and handle a slow first load.

## [0.7.0] - 2026-10-08

### Added

- `pullboard next` offers submitted work for review before build work; `--build` requests a build item.
- People can approve or decline proposed spec rows in Pullboard View, with choices recorded for the coordinator to apply.
- Command help is grouped by command, and `pullboard init` gives first-run guidance for the detected project ecosystem.

### Changed

- Pullboard View keeps action results and wait details usable on smaller screens.
- Staged-file secret scanning covers large files, including binary files.

## [0.6.1] - 2026-10-07

### Added

- A roadmap and milestone board lets a coordinator plan work across several items.
- Tagged releases publish to npm from CI with provenance.
- `pullboard init` adds first-run guidance for the detected project ecosystem.

### Changed

- An item's check is tried against committed `main`, so a check that already passed before the change is flagged.

## [0.6.0] - 2026-10-07

### Added

- Pullboard View shows live project activity and supports local API access and replayable static exports.
- Signed specification approvals and cross-family review receipts record who approved and checked work.
- Gate runs can wait in a resource-aware queue instead of competing for the same machine.

## [0.5.0] - 2026-10-07

### Added

- A local, spec-backed work board gives each item a frozen criterion, a separate worktree lane, a gated submission, and an independent review receipt.
- The timed tour demonstrates a change being rejected, corrected, and accepted with proof.

[Unreleased]: https://github.com/pullboard-dev/pullboard/compare/v0.8.7...HEAD
[0.8.7]: https://github.com/pullboard-dev/pullboard/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/pullboard-dev/pullboard/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/pullboard-dev/pullboard/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/pullboard-dev/pullboard/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/pullboard-dev/pullboard/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/pullboard-dev/pullboard/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/pullboard-dev/pullboard/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/pullboard-dev/pullboard/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/pullboard-dev/pullboard/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/pullboard-dev/pullboard/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/pullboard-dev/pullboard/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/pullboard-dev/pullboard/releases/tag/v0.5.0
