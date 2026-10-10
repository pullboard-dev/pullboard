# Changelog

Notable changes to Pullboard, for people using it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

[Unreleased]: https://github.com/pullboard-dev/pullboard/compare/v0.8.3...HEAD
[0.8.3]: https://github.com/pullboard-dev/pullboard/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/pullboard-dev/pullboard/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/pullboard-dev/pullboard/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/pullboard-dev/pullboard/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/pullboard-dev/pullboard/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/pullboard-dev/pullboard/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/pullboard-dev/pullboard/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/pullboard-dev/pullboard/releases/tag/v0.5.0
