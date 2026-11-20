# Event log kinds

Generated from `apps/cli/src/io/documentation/events` by `docs/formats/generate.mjs`; edit the declarations, then regenerate. The prose around this table stays in the Event log section of `docs/formats.md`.

<!-- events:start -->
| Kind | Actor | Detail fields |
| --- | --- | --- |
| `join` | joining agent | `lane`, `route`, optional `grantEngine`, optional `family` (the family the registration named, recorded from the family-declaration engine) |
| `family` | agent | `family` |
| `model` | agent | — |
| `moved` | coordinator | `path` |
| `add` | item creator | `lane`, `specIds`, `after`, `route`, optional `reviewFamily`, optional `reviewPolicy`, optional `checkTiming` (coordinator boolean, frozen with the criterion) |
| `companion` | requesting agent | `item`, `lane`, `key` (event item id names the parent) |
| `milestone_placed` | item creator or override actor | `milestone`, `rule`, `note`, automatic `position`, `inputs`, override `reason` |
| `edit` | editor | `brief`, `route`, `criterion`, `check`, `unfrozen`, optional `title` and `previousTitle` (the new title and the one it replaced), optional `after`, optional `pendingRefreeze`, engine-19 `reason`, `barCorrection`, optional `widenedCheck` (present only when a claim holder widens its own check: the test files added), optional `correctedFrozen` (digest of the bar frozen atomically with a correction), optional `reviewFamily`, optional `reviewPolicy`, optional `checkTiming` (coordinator boolean, frozen with the criterion), optional `machineVerification` (coordinator-only reversible authorization, exact bar digest and numbered commands) |
| `escalate` | builder, or coordinator | `from`, `to`, `note`, `attempt`, `rejections` |
| `attempt` | reporting agent | `n`, `seconds`, `result` |
| `relay_exclusion` | person | `action` (exclude, the durable opt-out intent), `path` (relayOff), `reason`, `channel`; event time and actor identify the request before machine settings persist it |
| `board_members` | coordinator | `document` (exact version-1 body with board, repository, revision and complete members, approving login and SSH signature; native moves and checkpoints carry it sealed) |
| `fact` | author | `id`, `kind`, `text`, `ref`, `supersedes`, engine-20 `implies`, `decision`, `supersededBy`, engine-30 `cause`, `neverAgain`, `channel` |
| `claim` | builder | `leaseUntil`, `digest`, optional `grantEngine` |
| `renew` | builder | `leaseUntil`, `digest`, optional `grantEngine`, admitted-submit `submitAdmission` (native id, commit, tree), typed-pipeline `submitOutcome` (original refusal code/text, frozen digest, derived pipelineCause) |
| `shared-usage` | participant | `id`, `seats`, `allocations`, `revision`, `observedAt`, `records`, `estimate` |
| `usage` | builder | `item`, `revision`, `observedAt`, `shared`, `records`, `estimate` |
| `release` | builder | `reasonCode`, optional `reason` |
| `submit` | builder | `commit`, `tree`, `policyCommit`, engine-9 `criterionDigest`, engine-38 `submissionProof`, optional `submissionSize` |
| `reserve` | reviewer | `until` |
| `accept` | reviewer | `reason`, `commit`, engine-20 `implies`, engine-33 `review`, engine-68 `note`, optional `machine` (native machine verdict with each frozen command and authenticated receipt) |
| `reject` | reviewer | `reason`, `commit`, engine-20 `implies`, engine-30 `cause`, engine-33 `review`, automatic-Rigor `causeDerivation`, clause-bound rejection `clause`, `clauseText`, `barKey`, typed-pipeline `pipelineCause` (fixed category; other retains explanation) |
| `bar-sharpen` | coordinator | `clause`, `clauseText`, `barKey`, `to`, `digest` |
| `strong-rejection-notice` | coordinator | `engine`, `route`, `builder`, `rejections` |
| `reject_returned` | coordinator | `rejection`, `builder`, `commit`, `note`, `reason`, `engine`, inactive `presence`, `heartbeatAt`, `observedAt` |
| `reopen` | coordinator, or reviewer | `commit`, `note`, `judgment`, engine-10 `supersedes`, `landingFailure`, engine-30 `cause`, engine-52 `conflict`, `withdrawnVerdict`, automatic-Rigor `causes`, `causeDerivation`, typed-pipeline `pipelineCause` (fixed category; other retains explanation) |
| `merged` | coordinator | `commit` |
| `landing_batch` | coordinator | `batch` |
| `landing-review-moved` | coordinator | `code`, `batch`, `verdict`, `checked`, `landed` |
| `landing_waiver` | person | `waiver` |
| `landing_flake` | coordinator | `flake` |
| `main-moved` | coordinator | `batch`, `items`, `sha` |
| `withdraw` | coordinator | `reason` |
| `refreeze` | coordinator, or live holder adopting a pending correction | `before`, `after`, optional `retainedClaim` |
| `lane-lead` | coordinator | `lane`, `seat` |
| `hold` | coordinator | `lane`, `reason` |
| `unhold` | coordinator | `lane` |
| `hold_item` | coordinator | `reason` |
| `unhold_item` | coordinator | `reason` |
| `guards` | board | `missing`, `changed`, `stale` |
| `rigor-notice` | rigor | `cause`, `items`, `occurrences`, `neverAgain`, `engine`, automatic-Rigor `drafts` |
| `rigor-draft` | rigor | `id`, `target`, `cause`, exact typed `source`, `unproved` (always true), `items`, `occurrences`, `engine` |
| `activity-delivered` | recipient | `interrupts`, `through`, `observedThrough`, `digestThrough` |
| `activity-acted` | recipient | `interrupts` |
| `shout` | sender | `shout`, `to`, `decision`, `request`, `answers`, `messageKind` |
| `shout_news` | sender | `shout`, `to`, `decision`, `request`, `answers` |
| `flake-observation` | reporting agent | `engine`, `observation` |
| `flake-repair` | reporting agent | `engine`, `key`, `item` |
| `test-quarantine` | reporting agent | `engine`, `file`, `name`, `tree`, `runs`, ledger `ledger` (true when the typed flake ledger filed it), automatic-Submit `autoSubmit` |
| `health-scan` | observing agent | `active`, optional `pendingCpu`, `digest`, `engine` |
| `health-failure` | sentinel | `key`, `cause`, `since`, `subject`, `owner`, `commit`, `engine` |
| `health-resolved` | sentinel | `key`, `cause`, `since`, `subject`, `owner`, `commit`, `engine` |
| `sentinel-proposal` | proposing agent | `row`, `digest`, `engine` |
| `sentinel-decision` | person | `name`, `digest`, `decision`, `reason`, `channel`, `engine` |
| `sentinel-start` | running agent | `name`, `digest`, `run`, `until`, `engine` |
| `sentinel-run` | running agent | `name`, `digest`, `run`, `result`, `engine` |
| `sentinel-failure` | sentinel | `name`, `digest`, `run`, `cause`, `engine` |
| `pass` | coordinator, or lane lead | `shout`, `to`, `decision`, `request`, `answers` |
| `answer` | answerer | `shout`, `to`, `decision`, `request`, `answers`, `outcome`, `channel`, engine-20 `implies`, `supersedes`, decision-origin `provenance` |
| `row_decision` | person | `record`, `channel` |
| `row_draft` | builder, or rigor | engine-55 `row`, `written` |
| `flake-observation` | reporting agent | engine-59 `engine`, `observation` |
| `flake-repair` | reporting agent | engine-59 `engine`, `key`, `item` |
| `row_apply` | coordinator | `events`, atomic cited-spec corrections `refreezes`, explicit draft omissions `skippedDrafts` |
| `person_signing` | enabling agent, or person | engine-76 `signed`, `request`, `presence`, `intent` |
| `person_proposal` | proposing agent | engine-76 `request`, `verb` |
| `source_advanced` | coordinator | Exact checked source and native receipt custody: `version`, `board`, `submitted`, `status`, `previous`, `inputHead`, `trunk`, `bar`, `patchDigest`, `episode`, `reviewEpisode`, `reviewBy`, `reviewUntil`, `verdict`, `head`, `tree`, `mergeTree`, `paths`, `generated`, `selectionDigest`, `phases`. |
| `next-idle` | idle seat | `version`, `engine`, `reason` (structured next observation; absent historical reasons stay unknown) |
| `review-default` | board | Review-policy migration: `engine`, `count`, `unfinished`. |
| `coordinator-usage` | coordinator | `session`, `observedAt`, `records`, `estimate` (one coordinator session's usage, kept under the board key coordinator:session with no item) |
<!-- events:end -->
