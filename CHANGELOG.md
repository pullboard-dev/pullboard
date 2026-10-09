# Changelog

Notable changes to Pullboard, for people using it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

[Unreleased]: https://github.com/pullboard-dev/pullboard/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/pullboard-dev/pullboard/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/pullboard-dev/pullboard/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/pullboard-dev/pullboard/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/pullboard-dev/pullboard/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/pullboard-dev/pullboard/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/pullboard-dev/pullboard/releases/tag/v0.5.0
