# File formats

Every table on this page is generated from source declarations by `node docs/tools/update-docs.js`; change the declarations, not the page. `--check` reports a stale copy without writing.

## SPEC.md and DOCTRINE.md

The row grammar, statuses, tiers, signers and id namespaces are on [docs/formats/spec.md](formats/spec.md).

## Proposed rulings and resume doctrine notes

Standing rulings and the resume doctrine notes are on [docs/formats/rulings.md](formats/rulings.md).

## Resume release notes

The `whatsNew` field and the per-checkout version record are on [docs/formats/resume-notes.md](formats/resume-notes.md).

## SQLite board schema

### Format versions

<!-- format-versions:start -->
| Format | Version | Version source | Upgrade rule |
| --- | --- | --- | --- |
| `CLI JSON envelope` | `1` | `JSON_SHAPES.version` in `packages/config/src/logic/json.js` | Keep optional fields additive within version 1; bump the envelope version for incompatible command/export shapes. |
| `row grammar` | `1` | `SPEC_GRAMMAR_VERSION` in `packages/spec/src/logic/grammar.js`; optional `<!-- pullboard-grammar N -->` line in either file (absence means the current grammar) | Both files share the version. A declared version must match; an incompatible grammar change requires a coordinated version bump and compatible files. No automatic conversion occurs. |
| `board schema` | `3` | `SCHEMA_VERSION` in `packages/store/src/io/board/schema/source.js`, persisted as `PRAGMA user_version` | On a write open of a board whose version is behind: create missing tables and indexes (version 3 adds the hot-path indexes), add missing columns in place with declared defaults, restore missing or changed triggers, and remove stale machine triggers without replacing rows. Read opens never migrate; a board at the current version whose shape differs is reported once on stderr and left as it is. |
| `event log` | `1` | `EVENT_LOG_VERSION` in `packages/store/src/io/board/schema/source.js`, persisted in `board_meta` as `event_log_version` | Older event-log versions upgrade in place; newer versions are refused with `EVENT_LOG_VERSION`. Preserve event rows when the board schema changes. |
| `move engine` | `280` | `ENGINE_VERSION` in `src/machine.js`, carried as `engine` in every sealed executable move | Bump when a move's meaning changes, independently of the event log and sealed envelope. A newer engine is refused with `ENGINE_VERSION`, naming both versions and asking you to upgrade Pullboard. |
<!-- format-versions:end -->

### Upgrade rules

<!-- upgrade-rules:start -->
| Older board condition | Behavior when opened |
| --- | --- |
| Missing declared tables or indexes | Create them with `CREATE ... IF NOT EXISTS`. |
| Missing declared columns | Add each with `ALTER TABLE ... ADD COLUMN` and its declared default. |
| Missing or changed declared triggers | Install the declared trigger definitions. |
| Undeclared `machine_` triggers | Drop them as stale. |
| A board that previously had guard triggers | Append a `guards` event listing missing, changed and stale trigger names. |
| An older schema version | Set `PRAGMA user_version` to the current `SCHEMA_VERSION` after installation. |
| Existing rows and event history | Keep them in the same board file; guard repair may append its `guards` event. |
<!-- upgrade-rules:end -->

### Board columns

<!-- board-columns:start -->
| Table | Column | Type | Rules |
| --- | --- | --- | --- |
| `agent` | `agent_id` | `TEXT` | `PRIMARY KEY` |
| `agent` | `agent_lane` | `TEXT` | `NOT NULL` |
| `agent` | `agent_path` | `TEXT` | `NOT NULL`; `UNIQUE` |
| `agent` | `agent_last_shout_id` | `INTEGER` | `NOT NULL`; `DEFAULT 0` |
| `agent` | `agent_route` | `TEXT` | `NOT NULL`; `DEFAULT 'strong'` |
| `agent` | `agent_family` | `TEXT` | `nullable` |
| `agent` | `agent_created_at` | `TEXT` | `NOT NULL` |
| `board_meta` | `meta_key` | `TEXT` | `PRIMARY KEY` |
| `board_meta` | `meta_value` | `TEXT` | `NOT NULL` |
| `event` | `event_id` | `INTEGER` | `PRIMARY KEY` |
| `event` | `event_at` | `TEXT` | `NOT NULL` |
| `event` | `event_by` | `TEXT` | `NOT NULL` |
| `event` | `event_kind` | `TEXT` | `NOT NULL` |
| `event` | `item_id` | `INTEGER` | `nullable` |
| `event` | `event_detail` | `TEXT` | `NOT NULL`; `DEFAULT '{}'` |
| `event_archive` | `event_id` | `INTEGER` | `PRIMARY KEY` |
| `event_archive` | `event_at` | `TEXT` | `NOT NULL` |
| `event_archive` | `event_by` | `TEXT` | `NOT NULL` |
| `event_archive` | `event_kind` | `TEXT` | `NOT NULL` |
| `event_archive` | `item_id` | `INTEGER` | `nullable` |
| `event_archive` | `event_detail` | `TEXT` | `NOT NULL`; `DEFAULT '{}'` |
| `event_archive` | `event_archived_at` | `TEXT` | `NOT NULL` |
| `hold` | `hold_lane` | `TEXT` | `PRIMARY KEY` |
| `hold` | `hold_reason` | `TEXT` | `NOT NULL` |
| `hold` | `hold_by` | `TEXT` | `NOT NULL` |
| `hold` | `hold_at` | `TEXT` | `NOT NULL` |
| `item` | `item_id` | `INTEGER` | `PRIMARY KEY` |
| `item` | `item_parent_id` | `INTEGER` | `nullable`; `REFERENCES item(item_id)` |
| `item` | `item_lane` | `TEXT` | `NOT NULL` |
| `item` | `item_title` | `TEXT` | `NOT NULL` |
| `item` | `item_criterion` | `TEXT` | `NOT NULL`; `DEFAULT ''` |
| `item` | `item_spec_ids` | `TEXT` | `NOT NULL`; `DEFAULT ''` |
| `item` | `item_after` | `TEXT` | `NOT NULL`; `DEFAULT ''` |
| `item` | `item_brief` | `TEXT` | `NOT NULL`; `DEFAULT ''` |
| `item` | `item_route` | `TEXT` | `NOT NULL`; `DEFAULT 'strong'` |
| `item` | `item_check` | `TEXT` | `NOT NULL`; `DEFAULT ''` |
| `item` | `item_status` | `TEXT` | `NOT NULL`; `DEFAULT 'open'` |
| `item` | `item_owner` | `TEXT` | `nullable` |
| `item` | `item_lease_until` | `TEXT` | `nullable` |
| `item` | `item_frozen` | `TEXT` | `nullable` |
| `item` | `item_frozen_digest` | `TEXT` | `nullable` |
| `item` | `item_built_by` | `TEXT` | `nullable` |
| `item` | `item_builder_family` | `TEXT` | `nullable` |
| `item` | `item_commit` | `TEXT` | `nullable` |
| `item` | `item_tree` | `TEXT` | `nullable` |
| `item` | `item_verdict` | `TEXT` | `nullable` |
| `item` | `item_verified_by` | `TEXT` | `nullable` |
| `item` | `item_merged_commit` | `TEXT` | `nullable` |
| `item` | `item_withdrawn_reason` | `TEXT` | `nullable` |
| `item` | `item_hold_reason` | `TEXT` | `nullable` |
| `item` | `item_hold_by` | `TEXT` | `nullable` |
| `item` | `item_hold_at` | `TEXT` | `nullable` |
| `item` | `item_created_by` | `TEXT` | `NOT NULL` |
| `item` | `item_created_at` | `TEXT` | `NOT NULL` |
| `item` | `item_updated_at` | `TEXT` | `NOT NULL` |
| `item` | `item_claim_head` | `TEXT` | `nullable` |
| `item` | `item_files` | `TEXT` | `NOT NULL`; `DEFAULT ''` |
| `item` | `item_review_by` | `TEXT` | `nullable` |
| `item` | `item_review_until` | `TEXT` | `nullable` |
| `item` | `item_reservation_holder` | `TEXT` | `nullable` |
| `item` | `item_reservation_by` | `TEXT` | `nullable` |
| `item` | `item_reservation_at` | `TEXT` | `nullable` |
| `job` | `job_id` | `TEXT` | `PRIMARY KEY` |
| `job` | `job_kind` | `TEXT` | `NOT NULL` |
| `job` | `job_item` | `INTEGER` | `nullable` |
| `job` | `job_candidate` | `TEXT` | `nullable` |
| `job` | `job_base` | `TEXT` | `nullable` |
| `job` | `job_step` | `TEXT` | `NOT NULL`; `DEFAULT 'queued'` |
| `job` | `job_attempt` | `INTEGER` | `NOT NULL`; `DEFAULT 0` |
| `job` | `job_lease_owner` | `TEXT` | `nullable` |
| `job` | `job_lease_until` | `INTEGER` | `NOT NULL`; `DEFAULT 0` |
| `job` | `job_created` | `INTEGER` | `NOT NULL` |
| `job` | `job_updated` | `INTEGER` | `NOT NULL` |
| `job_step` | `job_step_id` | `INTEGER` | `PRIMARY KEY` |
| `job_step` | `job_step_job` | `TEXT` | `NOT NULL`; `UNIQUE` |
| `job_step` | `job_step_name` | `TEXT` | `NOT NULL`; `UNIQUE` |
| `job_step` | `job_step_seq` | `INTEGER` | `NOT NULL`; `DEFAULT 0`; `UNIQUE` |
| `job_step` | `job_step_payload` | `TEXT` | `NOT NULL`; `DEFAULT '{}'` |
| `job_step` | `job_step_at` | `INTEGER` | `NOT NULL` |
| `run` | `run_job` | `TEXT` | `PRIMARY KEY` |
| `run` | `run_kind` | `TEXT` | `NOT NULL` |
| `run` | `run_item` | `INTEGER` | `nullable` |
| `run` | `run_candidate` | `TEXT` | `nullable` |
| `run` | `run_base` | `TEXT` | `nullable` |
| `run` | `run_state` | `TEXT` | `NOT NULL` |
| `run` | `run_attempt` | `INTEGER` | `NOT NULL`; `DEFAULT 0` |
| `run` | `run_outcome` | `TEXT` | `nullable` |
| `run` | `run_summary` | `TEXT` | `nullable` |
| `run` | `run_record` | `TEXT` | `nullable` |
| `run` | `run_lease_owner` | `TEXT` | `nullable` |
| `run` | `run_lease_until` | `INTEGER` | `NOT NULL`; `DEFAULT 0` |
| `run` | `run_created` | `INTEGER` | `NOT NULL` |
| `run` | `run_updated` | `INTEGER` | `NOT NULL` |
| `shout` | `shout_id` | `INTEGER` | `PRIMARY KEY` |
| `shout` | `shout_from` | `TEXT` | `NOT NULL` |
| `shout` | `shout_to` | `TEXT` | `NOT NULL` |
| `shout` | `shout_text` | `TEXT` | `NOT NULL` |
| `shout` | `shout_at` | `TEXT` | `NOT NULL` |
| `shout` | `shout_decision` | `INTEGER` | `NOT NULL`; `DEFAULT 0` |
| `shout` | `shout_answers` | `INTEGER` | `nullable` |
| `shout` | `shout_evidence_kind` | `TEXT` | `nullable` |
| `shout` | `shout_evidence_outcome` | `TEXT` | `nullable` |
| `shout` | `shout_evidence_item` | `INTEGER` | `nullable` |
| `shout` | `shout_evidence_commit` | `TEXT` | `nullable` |
| `shout` | `shout_request` | `INTEGER` | `NOT NULL`; `DEFAULT 0` |
| `shout` | `shout_request_outcome` | `TEXT` | `NOT NULL`; `DEFAULT ''` |
| `shout` | `shout_answered_at` | `TEXT` | `nullable` |
| `test_result` | `test_result_id` | `INTEGER` | `PRIMARY KEY` |
| `test_result` | `test_result_file` | `TEXT` | `NOT NULL`; `UNIQUE` |
| `test_result` | `test_result_input_key` | `TEXT` | `NOT NULL` |
| `test_result` | `test_result_command` | `TEXT` | `NOT NULL`; `UNIQUE` |
| `test_result` | `test_result_context` | `TEXT` | `NOT NULL` |
| `test_result` | `test_result_status` | `TEXT` | `NOT NULL` |
| `test_result` | `test_result_receipt` | `TEXT` | `NOT NULL`; `UNIQUE` |
| `test_result` | `test_result_origin` | `TEXT` | `NOT NULL` |
| `test_result` | `test_result_commit` | `TEXT` | `nullable` |
| `test_result` | `test_result_at` | `INTEGER` | `NOT NULL` |
| `verdict` | `verdict_id` | `INTEGER` | `PRIMARY KEY` |
| `verdict` | `item_id` | `INTEGER` | `NOT NULL`; `REFERENCES item(item_id)` |
| `verdict` | `verdict_by` | `TEXT` | `NOT NULL` |
| `verdict` | `verdict_verifier_family` | `TEXT` | `nullable` |
| `verdict` | `verdict_decision` | `TEXT` | `NOT NULL` |
| `verdict` | `verdict_reason` | `TEXT` | `NOT NULL` |
| `verdict` | `verdict_note` | `TEXT` | `NOT NULL`; `DEFAULT ''` |
| `verdict` | `verdict_commit` | `TEXT` | `NOT NULL` |
| `verdict` | `verdict_digest` | `TEXT` | `NOT NULL` |
| `verdict` | `verdict_head` | `TEXT` | `NOT NULL` |
| `verdict` | `verdict_at` | `TEXT` | `NOT NULL` |
<!-- board-columns:end -->

### Board indexes

<!-- board-indexes:start -->
| Index | Table | Columns | Unique |
| --- | --- | --- | --- |
| `board_meta_agent_session_value_v1` | `board_meta` | `meta_value` | no |
| `board_meta_grant_activation_unsafe_v1` | `board_meta` | `meta_key` | no |
| `board_meta_grant_activation_v2` | `board_meta` | `(expression)` | no |
| `event_archive_fact_identity_v2` | `event_archive` | `(expression)`, `event_id` | no |
| `event_archive_fact_malformed_v2` | `event_archive` | `event_id` | no |
| `event_archive_fact_unknown_v2` | `event_archive` | `event_id` | no |
| `event_archive_item_id_event_id` | `event_archive` | `item_id`, `event_id` | no |
| `event_by_at` | `event` | `event_by`, `event_at` | no |
| `event_by_id` | `event` | `event_by`, `event_id` | no |
| `event_by_kind_id` | `event` | `event_by`, `event_kind`, `event_id` | no |
| `event_fact_identity_v2` | `event` | `(expression)`, `event_id` | no |
| `event_fact_malformed_v2` | `event` | `event_id` | no |
| `event_fact_unknown_v2` | `event` | `event_id` | no |
| `event_item_id_event_id` | `event` | `item_id`, `event_id` | no |
| `event_kind_id` | `event` | `event_kind`, `event_id` | no |
| `item_lane_status` | `item` | `item_lane`, `item_status` | no |
| `item_owner_status` | `item` | `item_owner`, `item_status` | no |
| `item_parent_status` | `item` | `item_parent_id`, `item_status`, `item_merged_commit` | no |
| `item_status_id` | `item` | `item_status`, `item_id` | no |
| `item_verified_unmerged` | `item` | `item_id` | no |
| `job_kind_created` | `job` | `job_kind`, `job_created` | no |
| `job_kind_item` | `job` | `job_kind`, `job_item` | no |
| `job_lease_live` | `job` | `job_lease_until` | no |
| `job_step_lease` | `job` | `job_step`, `job_lease_until` | no |
| `job_step_name_at` | `job_step` | `job_step_name`, `job_step_at` | no |
| `job_step_name_seq` | `job_step` | `job_step_name`, `job_step_seq` | no |
| `job_step_updated` | `job` | `job_step`, `job_updated`, `job_kind` | no |
| `run_item_kind` | `run` | `run_item`, `run_kind` | no |
| `run_open` | `run` | `run_state` | no |
| `shout_answers` | `shout` | `shout_answers` | no |
| `shout_evidence_item` | `shout` | `shout_evidence_item` | no |
| `shout_from_at` | `shout` | `shout_from`, `shout_at` | no |
| `shout_open_coordinator_callout` | `shout` | `shout_id` | no |
| `shout_open_decision` | `shout` | `shout_decision`, `shout_to` | no |
| `shout_open_request` | `shout` | `shout_request` | no |
| `shout_target_id` | `shout` | `shout_to`, `shout_id` | no |
| `test_result_commit_file` | `test_result` | `test_result_commit`, `test_result_command`, `test_result_file` | no |
| `test_result_key` | `test_result` | `test_result_input_key`, `test_result_command`, `test_result_context` | no |
| `verdict_item_id_verdict_id` | `verdict` | `item_id`, `verdict_id` | no |
<!-- board-indexes:end -->

### Board triggers

<!-- board-triggers:start -->
| Trigger | Table |
| --- | --- |
| `machine_event_delete` | `event` |
| `machine_event_update` | `event` |
| `machine_fields_claimed` | `item` |
| `machine_fields_submitted` | `item` |
| `machine_fields_verified` | `item` |
| `machine_fields_withdrawn` | `item` |
| `machine_item_delete` | `item` |
| `machine_item_move` | `item` |
| `machine_item_start` | `item` |
| `machine_item_state` | `item` |
| `machine_proof_verified` | `item` |
| `machine_verdict_delete` | `verdict` |
| `machine_verdict_update` | `verdict` |
<!-- board-triggers:end -->

### Temp columns

<!-- temp-columns:start -->
| Table | Column | Type | Rules |
| --- | --- | --- | --- |
| `moving` | `token` | `INTEGER` | `nullable` |
<!-- temp-columns:end -->

### Temp triggers

<!-- temp-triggers:start -->
| Trigger | Table |
| --- | --- |
| `status_through_moves` | `item` |
<!-- temp-triggers:end -->

## Local board identities and cross-board moves

## Event log

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
| `next-finished` | idle seat | `version`, `engine`, `lane` (a seat that finished its loop, once per seat) |
| `next-idle` | idle seat | `version`, `engine`, `reason` (structured next observation; absent historical reasons stay unknown) |
| `next-idle-timeout` | idle seat | `version`, `engine`, `lane`, `minutes`, `awaited` (a next call that gave up waiting) |
| `review-default` | board | Review-policy migration: `engine`, `count`, `unfinished`. |
| `coordinator-usage` | coordinator | `session`, `observedAt`, `records`, `estimate` (one coordinator session's usage, kept under the board key coordinator:session with no item) |
<!-- events:end -->

## Flow report and captured submission size

## Submit test selection

## Static view export

The exported files, the replay page and the landing, Rigor and release-receipt engine notes are on [docs/formats/static-view.md](formats/static-view.md).

## Native proof provenance

## Approval provenance

## Offline flow replay

## Recorded board line settings

The eight line settings and their ranges, the ordering and landing engine notes, outside intake and sandbox receipts, capacity decisions, item decision options and signed board membership are on [docs/formats/settings.md](formats/settings.md).

## Seat addresses

## Machine-local runner rate card

A runner's rate card (`runnerRates`, set with `pullboard settings runnerRates`) is described on [docs/formats/rate-card.md](formats/rate-card.md).

## Machine-local relay canary
