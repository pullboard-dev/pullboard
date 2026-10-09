# File formats

This page describes the text files people edit and the SQLite board kept inside `.git`. The row parser is in `src/spec.js`; board declarations and migrations are in `src/board.js`; lifecycle guards are generated from `src/machine.js`.

## SPEC.md and DOCTRINE.md

Doctrine means the house rules for agentic development. New repos use `DOCTRINE.md`; existing `PRACTICE.md` files keep working. Rename a tracked legacy file with `git mv -- PRACTICE.md DOCTRINE.md`; for an untracked file, use `mv -- PRACTICE.md DOCTRINE.md`. Keeping both names is refused because they define the same repo doctrine. The configuration and API retain their `practice` field names; an explicitly configured custom path still works.

Both files use the shared row grammar in `src/spec.js`, whose version is `SPEC_GRAMMAR_VERSION`. Either file may declare the current version on its own line as `<!-- pullboard-grammar N -->`; without a marker, the file uses the current grammar. A marker inside a fenced code example is ignored. The parser accepts only the version it reads and refuses a mismatched or invalid marker with `A5_GRAMMAR_VERSION`; upgrade Pullboard or use a file written for its grammar. Pullboard does not rewrite these files during an upgrade.

A section begins with `## `; a row must be beneath a section and occupies one line:

```text
- ID [status[, tier]] requirement text | gate: <command> | serves: <ID, ID> | signers: <principal, principal>
```

The identifier expression, statuses and tiers below come from the parser:

<!-- id-pattern:start -->
| Identifier | Parser expression |
| --- | --- |
| `ID` | `^[A-Za-z]+\d+(?:\.\d+)*$` |
<!-- id-pattern:end -->

<!-- statuses:start -->
| Status | Meaning |
| --- | --- |
| `approved` | decided and in force |
| `draft` | proposed, not decided |
| `pending` | open question |
| `fact` | true today |
| `wont` | not building; the row stays permanent |
| `retired` | no longer in force; the row stays permanent |
<!-- statuses:end -->

<!-- tiers:start -->
| Tier | Meaning |
| --- | --- |
| `must` | An approved must row names a gate. Other statuses may omit it. |
| `aim` | An aim; no gate is required. |
<!-- tiers:end -->

After the requirement text, `gate:` names the check, `serves:` names comma-separated ids, and `signers:` names comma-separated SSH principals; each field may be omitted. Each signer is one unique principal with no spaces, commas or leading `#`; the list names the exact principals required for signed sign-offs. An approved row is met only when every listed principal has a verified SSH receipt for its current text; missing, stale or unverified receipts leave it unmet. Other trailing keys are recorded as unknown and rejected by `spec check`. A malformed row-like line is an error, and rows inside fenced code blocks are examples rather than input. IDs are permanent: mark a cut row `wont` or `retired` instead of deleting it.

The row object returned by `parseSpec` has these fields:

### ID namespaces and collisions

A bare id names a row in `SPEC.md`. A doctrine row is cited as `doctrine:<id>` in item spec ids and commit headers, even when a row with the same bare id exists in `SPEC.md`. `spec check` compares the current rows in `SPEC.md` and `DOCTRINE.md` (or a legacy `PRACTICE.md`), and rows within either file. Collisions already present in the primary checkout's attached branch are reported as known warnings; adding a colliding row is an error that names both file paths and line numbers. A detached primary checkout cannot establish this baseline. A commit that cites a bare id shared with a doctrine row warns that the bare id resolves to `SPEC.md`; use the `doctrine:` prefix to cite the doctrine row.

`parseSpec` also returns `grammarVersion`, equal to `SPEC_GRAMMAR_VERSION` after the file's marker has been checked.

<!-- parser-fields:start -->
| Parsed field | Meaning |
| --- | --- |
| `id` | Stable row identifier. |
| `status` | One token from the status list. |
| `tier` | Optional second token: must or aim. |
| `text` | Requirement text before trailing fields. |
| `gate` | Check named by gate, or an empty string. |
| `serves` | Comma-separated ids named by serves, or an empty list. |
| `signers` | Comma-separated SSH principals named by signers, or an empty list. |
| `unknown` | Unrecognized trailing fields; spec check reports them. |
| `section` | Containing ## heading. |
| `line` | 1-based source line. |
<!-- parser-fields:end -->

## SQLite board schema

The board file is in the repository's Git common directory at `.git/pullboard/board.sqlite`. File-backed connections use WAL mode, so `board.sqlite-wal` and `board.sqlite-shm` can sit beside it while connections are open. SQLite `PRAGMA user_version` records the board schema version; it also marks whether trigger repairs are reported in the event log. Schema objects are created from `src/board.js` when a board opens.

<!-- format-versions:start -->
| Format | Version | Version source | Upgrade rule |
| --- | --- | --- | --- |
| `CLI JSON envelope` | `1` | `JSON_SHAPES.version` in `src/json.js` | Keep optional fields additive within version 1; bump the envelope version for incompatible command/export shapes. |
| `row grammar` | `1` | `SPEC_GRAMMAR_VERSION` in `src/spec.js`; optional `<!-- pullboard-grammar N -->` line in either file (absence means the current grammar) | Both files share the version. A declared version must match; an incompatible grammar change requires a coordinated version bump and compatible files. No automatic conversion occurs. |
| `board schema` | `2` | `SCHEMA_VERSION` in `src/board.js`, persisted as `PRAGMA user_version` | Create missing tables and indexes, add missing columns in place with declared defaults, restore missing or changed triggers, and remove stale machine triggers without replacing rows. |
| `event log` | `1` | `EVENT_LOG_VERSION` in `src/board.js`, persisted in `board_meta` as `event_log_version` | Older event-log versions upgrade in place; newer versions are refused with `EVENT_LOG_VERSION`. Preserve event rows when the board schema changes. |
| `move engine` | `5` | `ENGINE_VERSION` in `src/machine.js`, carried as `engine` in every sealed executable move | Bump when a move's meaning changes, independently of the event log and sealed envelope. A newer engine is refused with `ENGINE_VERSION`, naming both versions and asking you to upgrade Pullboard. |
<!-- format-versions:end -->

Pullboard 0.6.1 released engine 1. Engine 2 records a fresh explicit-build claim's skipped-review snapshot. Pullboard 0.8.1 released engine 3, including lane-sensitive graft refusals and authenticated relay senders. Engine 4 adds captured background-baseline completions through `completeCheckBaseline`; released engine-3 clients stop with `ENGINE_VERSION` before interpreting this new operation or advancing their replay cursor. Engine 5 requires a one-line reason when releasing a review and gives that reviewer a one-hour cooldown for the current submission. Each sealed move replays under its recorded engine version: engines 1 through 4 retain the original release event and review-reservation behavior. Engine 5 retains support for older moves, including engine-4 baseline completions. Upgrade every linked device before using the new moves.

The CLI declares its engine in every relay request's `X-Pullboard-Engine` header.
A linked board requires at least engine 3 after issuing any agent token, including
revoked or expired tokens. The minimum survives reopening the auth database;
unlink removes the board and ends its lifetime. A missing declaration is legacy
engine 1. Board-content requests below their minimum, and malformed declarations,
receive `ENGINE_VERSION` with upgrade guidance before records are returned or
changed. The service checks again under its board lock and on live-stream polls.

Engine 3 checks each move or request against the relay's authenticated sender before replay. An agent token acts only as its named agent and cannot act as the person. Refused attribution attempts advance the sequence with a `relay_refusal_<sequence>` receipt and a `relay_refused` event naming the sender, attempted actor and refusal code. They change no item, shout or verdict and do not reserve the forged operation id. Snapshot restoration requires a person sender. The event log remains version 1.

A board without `event_log_version` is a legacy version-0 event log. Opening an older board writes the current marker without replacing its events. Opening a newer event log refuses with `EVENT_LOG_VERSION`, naming the stored and supported versions and asking you to upgrade Pullboard. `doctor` reports that version conflict read-only.

A native board export includes the marker in its `board_meta` rows. Import refuses a newer event-log version before changing the destination; an older export upgrades its marker in place. Static view exports put `eventLogVersion` beside the data in both `state.json` and `events.json`, separately from the API envelope's `version`.

Linked clients seal an executable operation and its deterministic inputs. The relay assigns its sequence and receipt timestamp without reading the operation. Each client runs the CLI's board engine at that timestamp. Successful results and engine refusals advance `board_meta.relay_applied_sequence` in the same transaction as the move's receipt, keyed by `relay_receipt_<operation-id>`; retries return the recorded outcome. An identical operation id and descriptor at a later relay position advances the prefix without another event and returns its first outcome. The same id with different contents is refused with `RELAY_MOVE`. `relay_engine_version` records the checkpoint's executable semantics. A future engine stops replay before either its rows or its cursor changes.

A sealed checkpoint keeps the native export tables importable and may carry the local API presentation beside them. Its public sequence equals `relay_applied_sequence`, so clients can restore a compacted prefix and continue after it. The older local-first mirror drains only its already-durable outbox, then publishes a checkpoint covering the acknowledged prefix without executing those events again. A divergent old outbox is refused with the relay and local sequences; re-link from that machine or join by pairing.

The in-place upgrade behavior is exercised by `exerciseUpgrade` in `docs/formats.test.js`:

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

An older board that has not yet recorded its guard marker receives the current triggers and marker quietly. `openBoard` does not replace the board file or existing rows.

The following live SQLite declarations include nullability, defaults, primary and unique keys, and foreign keys:

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
| `item` | `item_created_by` | `TEXT` | `NOT NULL` |
| `item` | `item_created_at` | `TEXT` | `NOT NULL` |
| `item` | `item_updated_at` | `TEXT` | `NOT NULL` |
| `item` | `item_claim_head` | `TEXT` | `nullable` |
| `item` | `item_files` | `TEXT` | `NOT NULL`; `DEFAULT ''` |
| `item` | `item_review_by` | `TEXT` | `nullable` |
| `item` | `item_review_until` | `TEXT` | `nullable` |
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

<!-- board-indexes:start -->
| Index | Table | Columns | Unique |
| --- | --- | --- | --- |
| `item_lane_status` | `item` | `item_lane`, `item_status` | no |
<!-- board-indexes:end -->

`src/machine.js` declares the lifecycle and retained records. `src/board.js` installs these persistent triggers in the board file:

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

`machine_item_start`, `machine_item_state` and `machine_item_move` guard lifecycle states and moves. `machine_fields_*` requires each state's fields; `machine_proof_*` requires its proof. `machine_item_delete` keeps item rows, while `machine_verdict_*` and `machine_event_*` make those records append-only.

Each connection also has a temporary `moving(token INTEGER)` table and `status_through_moves` trigger. The trigger allows status changes only while `moveItem` holds the token; these objects are not stored in the board file.

<!-- temp-columns:start -->
| Table | Column | Type | Rules |
| --- | --- | --- | --- |
| `moving` | `token` | `INTEGER` | `nullable` |
<!-- temp-columns:end -->

<!-- temp-triggers:start -->
| Trigger | Table |
| --- | --- |
| `status_through_moves` | `item` |
<!-- temp-triggers:end -->

## Event log

The `event` table is a SQLite schema object governed by `SCHEMA_VERSION`; its append-only record format has the independent `EVENT_LOG_VERSION`. Each event has an increasing integer id, an ISO timestamp, the actor, the event kind, an optional item id, and a JSON object in `event_detail`. Board moves append their event inside the same immediate transaction as the move. Events are append-only; board triggers reject updates and deletes. The actor column is the acting agent id, except guard-repair events, which use `board`. The following rows name the emitted kinds and their established detail keys; CLI accept events additionally carry the frozen-check result described below:

<!-- events:start -->
| Kind | Actor | Detail fields |
| --- | --- | --- |
| `join` | joining agent | `lane`, `route` |
| `family` | agent | `family` |
| `moved` | coordinator | `path` |
| `add` | item creator | `lane`, `specIds`, `after`, `route` |
| `edit` | editor | `brief`, `route`, `criterion`, `check`, `unfrozen` |
| `escalate` | builder | `from`, `to`, `note`, `attempt` |
| `attempt` | reporting agent | `n`, `seconds`, `result` |
| `fact` | author | `id`, `kind`, `text`, `ref`, `supersedes` |
| `claim` | builder | `leaseUntil`, `digest` |
| `renew` | builder | `leaseUntil`, `digest` |
| `release` | builder | — |
| `submit` | builder | `commit`, `tree`, `policyCommit` |
| `reserve` | reviewer | `until` |
| `accept` | reviewer | `reason`, `commit` |
| `reject` | reviewer | `reason`, `commit` |
| `merged` | coordinator | `commit` |
| `withdraw` | coordinator | `reason` |
| `refreeze` | coordinator | `before`, `after` |
| `hold` | coordinator | `lane`, `reason` |
| `unhold` | coordinator | `lane` |
| `guards` | board | `missing`, `changed`, `stale` |
| `shout` | sender | `shout`, `to`, `decision`, `request`, `answers` |
| `pass` | coordinator | `shout`, `to`, `decision`, `request`, `answers` |
| `answer` | answerer | `shout`, `to`, `decision`, `request`, `answers`, `outcome`, `channel` |
| `row_decision` | person | `record`, `channel` |
| `row_apply` | coordinator | `events` |
<!-- events:end -->

A CLI `accept` event includes `check: "none"` when no frozen item check ran or `check: "green"` when it passed. Older accept events and records without this field read as `unknown`; the result stays in event detail and does not change the board schema or event-log version.

Item facts use the existing append-only `event` table and event-log version 1. A `fact` event's actor and timestamp stamp its author and time; its detail carries a stable string `id`, typed `kind`, exact `text`, optional `ref` binding or `null`, and superseded fact id or `null`. Allowed kinds are `capture`, `measurement`, `note`, `diff`, `decision`, `rejection`, `supersession` and `root-cause`. Judgement kinds and any correction using `supersedes` require the item's live holder or the coordinator. A correction must refer to a fact on the same item; it adds a new event and preserves every earlier fact.

A binding is `{path, start, end, commit}`: a relative repository path, a positive ascending inclusive line range and a full 40-character hexadecimal commit id. It identifies code without storing source or requiring Git on a replica. Fact ids are generated UUIDs locally. A sealed `appendFact` operation uses its executable move id as its fact id, so replicas keep corrections bound to the same fact even when local event sequence ids differ. Native export/import retains these event rows without a separate fact table or schema upgrade.

The derived `thread` in CLI `show` JSON and API v1 item state is an array in ascending event order. Move entries are `{type: "move", eventId, kind, by, at, detail}`. Fact entries are `{type: "fact", id, eventId, kind, text, by, at, ref, supersedes}`. `eventId` is the board's numeric event sequence; `id` is the stable fact identity used by corrections. `by` and `at` come from the immutable event author and UTC timestamp. `detail` retains a move's original structured payload. Nullable `ref` and `supersedes` preserve omitted fields as `null`. Superseded facts remain in the array beside their corrections.

Engine version 3 adds the sealed `appendFact` operation. It is the single engine increment reserved for the release after 0.7.0; other changes in that release reuse version 3. Older supported operations remain replayable; an older client refuses a version-3 move before applying it. The sealed envelope, CLI/API envelope, schema and event-log layout versions are unchanged.

New CLI claims include a `policy` object (`version: 1`, `commit`, `verify: { policy, family }`) in the frozen criterion. It pins the coordinator checkout’s committed configuration on its attached main branch and captures that commit’s verification and family rules. Relay verification uses those shared frozen values, ignoring policy values supplied by the sealed move; missing or invalid captured values produce `NO_POLICY` with an explicit refreeze step. An ordinary criterion recheck preserves legacy frozen bytes and their digest. An explicit refreeze captures the pinned commit’s verification rules and establishes a new digest. A temporary detached review checkout refuses new policy-dependent claims or project gates with `NO_POLICY`; the coordinator returns to its main branch. Existing frozen submissions remain verifiable. Legacy claims use their recorded claim-base commit. A CLI `submit` records the pre-merge coordinator HEAD as optional `policyCommit`; historical doctor and acceptance checks use this snapshot when allowing unchanged foreign files brought in from MAIN. Verified dependencies may also contribute unchanged files in their own lanes before a MAIN merge; foreign deletion or replacement is not authorized by an unrelated dependency’s tree. The complete candidate diff against both claim base and frozen MAIN is checked with rename detection disabled, preserving deleted paths and whitespace in names. Frozen item checks run against the exact submitted commit in an isolated checkout when accepting and auditing; repairing a reviewer’s checkout cannot make a red submission green.

Person answer events additionally record their `channel`, either `terminal` or `view`, including the forwarded answer to the original asker. Agent answers omit that field.

Person row decisions use one `row_decision` event per row. Its `record` holds `kind` (`spec` or `doctrine`), file, id, exact source and replacement lines, target text, decision, reason and identity. SSH approvals additionally hold the canonical signature and trust anchors. The current index is additive `board_meta` key `row_decisions`; each entry includes its event id, timestamp and applied state. Coordinator `row_apply` events name the exact decision event ids applied locally. Replica replay changes board metadata only and never writes checkout files.

An approval of proposed new wording uses that same record: `source` is the existing exact line and `replacement` carries the approved target text. Pre-commit compares the staged target against the person decision or a verified staged signed receipt. No second approval format or event kind is needed.

Migration preserves event rows and adds only schema objects that are missing.

<!-- pass-rule:start -->
The `pass` event is emitted by `passDecision` only for the coordinator; another agent receives `COORDINATOR_ONLY`. Its event actor is the coordinator. The person receives the passed decision, while the event table records who performed the pass.
<!-- pass-rule:end -->

## Static view export

`pullboard view --export DIR` writes a read-only site from the same API v1 documents used by the live view. The page fetches these files without a session key and reads the events file to replay the snapshot. The export contains no server, credentials or writable board actions.

<!-- snapshot-files:start -->
| File below `DIR` | Contents and reader |
| --- | --- |
| `index.html` | Snapshot page; reads the JSON files below and drives event replay. |
| `view.css` | Stylesheet linked by `index.html`. |
| `api/v1/boards.json` | API v1 board listing; the page selects the board to show. |
| `api/v1/boards/<board-id>/state.json` | API v1 state for that board; the page uses it as the final snapshot. |
| `api/v1/boards/<board-id>/events.json` | API v1 event list; the page replays it from the selected board state. |
<!-- snapshot-files:end -->

The schema, trigger and parser tables are checked against live `openBoard(':memory:')` and `parseSpec` results. The static export is generated and its files, API v1 shapes and page readers are checked by `docs/formats.test.js`.
