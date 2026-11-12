# File formats

This page describes the text files people edit and the SQLite board kept inside `.git`. The row parser is in `packages/spec/src/logic/grammar.js`; board declarations and migrations are in `packages/store/src/io/board.js`; lifecycle guards are generated from `packages/state/src/io/machine.js`.

Run `node docs/tools/update-docs.js` to refresh the marked tables, API shapes, lifecycle page and full CLI help. `--check` reports stale copies without writing. Change source declarations rather than these tables; normal landing regenerates outputs after every merge and engine allocation. Add a command's help and required JSON fields in its own `src/command-docs/<name>.json`, beside its independently discovered command implementation. Source-owned event descriptions live in separate `src/documentation/events/<kind>.json` files; authored prose outside tables is retained.

## SPEC.md and DOCTRINE.md

Doctrine means the house rules for agentic development. New repos use `DOCTRINE.md`; existing `PRACTICE.md` files keep working. Rename a tracked legacy file with `git mv -- PRACTICE.md DOCTRINE.md`; for an untracked file, use `mv -- PRACTICE.md DOCTRINE.md`. Keeping both names is refused because they define the same repo doctrine. The configuration and API retain their `practice` field names; an explicitly configured custom path still works.

Both files use the shared row grammar in `packages/spec/src/logic/grammar.js`, whose version is `SPEC_GRAMMAR_VERSION`. Either file may declare the current version on its own line as `<!-- pullboard-grammar N -->`; without a marker, the file uses the current grammar. A marker inside a fenced code example is ignored. The parser accepts only the version it reads and refuses a mismatched or invalid marker with `A5_GRAMMAR_VERSION`; upgrade Pullboard or use a file written for its grammar. Pullboard does not rewrite these files during an upgrade.

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

After the requirement text, `gate:` names the check, `serves:` names comma-separated ids, and `signers:` names comma-separated SSH principals; each field may be omitted. Each signer is one unique principal with no spaces, commas or leading `#`; the list names the exact principals required for signed sign-offs. An approved row is met only when every listed principal has a verified SSH receipt for its current text; missing, stale or unverified receipts leave it unmet. A row may also carry `source:`, the reference a blueprint rule came from, written as its name, then its id and address when it has them (`| source: Example Framework OPS 8 https://example.com/ops-8`). The parsed row gains a `source` string only when the field is written, so a row without one parses exactly as before; an empty `source:` is an error. `spec show` prints the source and `spec --json` rows carry it. Other trailing keys are recorded as unknown and rejected by `spec check`. A malformed row-like line is an error, and rows inside fenced code blocks are examples rather than input. IDs are permanent: mark a cut row `wont` or `retired` instead of deleting it.

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

### Blueprint rule sources

A blueprint is one JSON file (format 1, described at the top of `packages/blueprints/index.js`). Its `kind` is `product`, `architecture`, `practice` or `beyond-code`; a file that says `infrastructure`, the old name, loads as `architecture`. A rule may carry `source: { name, id, url }`: `name` is required, `id` and `url` are optional, each is one line without `|`, and `url` is an `http` or `https` address. `pullboard blueprint add` and `init --blueprint` copy it onto the drafted row's `source:` field; the row's text stays the rule and its reason. Every rule of an architecture blueprint names its source, since it paraphrases a known-good reference: a rule without one refuses the blueprint with `BLUEPRINT_NO_SOURCE`, naming the blueprint and the rule, when it is loaded or saved.
## Proposed rulings and resume doctrine notes

The coordinator proposes a standing ruling with `pullboard spec draft "<rule>" --doctrine --source "chat, 2026-10-16"` (or a shout reference such as `"shout 42"`). A source is required. The draft lives in the configured doctrine file, with `Source: ...` in its text, and the returned id is qualified as `doctrine:DR1`. The person approves or declines that id through the existing `spec approve` or `spec decline` commands; the coordinator runs `spec apply`.

`resume --json` includes `doctrineNotes`, an array of newly seen approved repo rules, each with `id`, `text` and `gate`. Drafts and pending applications are excluded. Text resume prints the same rules. Each checkout records its own displayed rule text under its Git directory, so a second checkout receives its own notice. Repeated resumes return an empty array until an approved rule changes.

Resume and criterion freezing use the primary branch's committed doctrine together with the person's applied exact-row decisions. An older agent checkout can therefore read an approved ruling and detect that a frozen citation is stale without changing its branch or local doctrine file. Proposed or unapplied changes do not replace the in-force rule.

## Resume release notes

<!-- resume-release-notes:start -->
`pullboard resume --json` adds a `whatsNew` field to its version-1 envelope. `whatsNew` is `null` when nothing is new. After an upgrade it contains the released versions newer than this checkout last ran, newest first:

```json
{
  "whatsNew": {
    "releases": [
      {
        "version": "0.8.7",
        "headline": "A new session",
        "paragraph": "Release headline paragraph."
      }
    ],
    "omitted": 0,
    "notes": "CHANGELOG.md"
  }
}
```

Each `releases` entry has a version number, the release headline from its `###` heading in `CHANGELOG.md`, and that heading's paragraph. Added, Changed and Fixed lists are excluded. Only the newest three releases are included; `omitted` counts the earlier releases left out, and `notes` names the full release notes.

Both text and JSON resumes record the displayed version once per checkout. Later resumes at the same version have no extra text and a null `whatsNew` field. A checkout's first run records its version quietly. The record is `pullboard-checkout/resume-version` in the checkout's Git directory, outside the shared board; linked worktrees keep separate records. JSON resume includes the notes in its response when recording that version, so a JSON call does not consume notes without exposing them.
<!-- resume-release-notes:end -->

## SQLite board schema

The board file is in the repository's Git common directory at `.git/pullboard/board.sqlite`. File-backed connections use WAL mode, so `board.sqlite-wal` and `board.sqlite-shm` can sit beside it while connections are open. SQLite `PRAGMA user_version` records the board schema version; it also marks whether trigger repairs are reported in the event log. Schema objects are created from `packages/store/src/io/board.js` when a board opens.

## Local board identities and cross-board moves

A repository's team board lives in its Git common directory at `.git/pullboard/board.sqlite`. The device registry records the exact GitHub origin owner/name and immutable board ID; a display name or checkout path is not a board identity. New items go to the team board by default; `pullboard add --private` selects the device-local private board. That private board lives at `~/.pullboard/private/<team-board-id>/board.sqlite` (or under the configured `PULLBOARD_HOME`). Its private reference stores the signed-in person's GitHub login as owner metadata and the repository's origin owner/name as its handle; for example, `~acme/web` identifies the private board for `acme/web`, regardless of the signed-in person's login. The board itself remains device-local unless an item is deliberately moved to a team board (`packages/seats/src/io/projects.js`).

Item numbers belong to one board. A bare number such as `12` means the current board; a team item can be named `web#12` or `owner/web#12`, and a private item `~web#12` or `~owner/web#12` uses the repository origin owner/name. A bare handle resolves only when unique in the authorized local inventory; ambiguous handles list the qualified choices (`src/board-reference.js`, `packages/store/src/io/board/inventory.js`). A dependency on another repository is written `repo#id`; it is satisfied only by that item on its own board after verification, and `pullboard next` names the item it waits for.

`pullboard move <item-ref> --to <handle>` moves an open or verified item between the current repository's team board and its private board; `--private` selects that repository's private board for a bare numeric source ID. An ordered destination reservation chooses the target ID first. The source move then records one stable MOVEID and leaves a permanent redirect at the old source ID, which is never reused; destination application is keyed to the source board and MOVEID, so retrying a failed delivery reuses the same ID and cannot create a second item (`apps/cli/src/io/commands/move.js`, `packages/items/src/io/rehome.js`). Move a local parent or wait item first when the destination needs its corresponding item there. A verified import carries the original source ACCEPT, commit, digest and verifier as imported provenance; it is not a new review by the destination board.

The version table is generated from the source-owned declarations in `src/formats/*.json` and their existing version constants. Add a declaration beside the format source instead of editing the table; `node docs/tools/update-formats.js` refreshes it, and the native landing train refreshes it after merging.

<!-- format-versions:start -->
| Format | Version | Version source | Upgrade rule |
| --- | --- | --- | --- |
| `CLI JSON envelope` | `1` | `JSON_SHAPES.version` in `packages/config/src/logic/json.js` | Keep optional fields additive within version 1; bump the envelope version for incompatible command/export shapes. |
| `row grammar` | `1` | `SPEC_GRAMMAR_VERSION` in `packages/spec/src/logic/grammar.js`; optional `<!-- pullboard-grammar N -->` line in either file (absence means the current grammar) | Both files share the version. A declared version must match; an incompatible grammar change requires a coordinated version bump and compatible files. No automatic conversion occurs. |
| `board schema` | `3` | `SCHEMA_VERSION` in `packages/store/src/io/board/schema/source.js`, persisted as `PRAGMA user_version` | On a write open of a board whose version is behind: create missing tables and indexes (version 3 adds the hot-path indexes), add missing columns in place with declared defaults, restore missing or changed triggers, and remove stale machine triggers without replacing rows. Read opens never migrate; a board at the current version whose shape differs is reported once on stderr and left as it is. |
| `event log` | `1` | `EVENT_LOG_VERSION` in `packages/store/src/io/board/schema/source.js`, persisted in `board_meta` as `event_log_version` | Older event-log versions upgrade in place; newer versions are refused with `EVENT_LOG_VERSION`. Preserve event rows when the board schema changes. |
| `move engine` | `250` | `ENGINE_VERSION` in `src/machine.js`, carried as `engine` in every sealed executable move | Bump when a move's meaning changes, independently of the event log and sealed envelope. A newer engine is refused with `ENGINE_VERSION`, naming both versions and asking you to upgrade Pullboard. |
<!-- format-versions:end -->

A signed board uses event-log format 2; older tools refuse it.

A builder never picks an engine number (#1101). An item that adds a board move adds its own `src/<name>-engine.js` leaf as `export const NAME_ENGINE = unassignedEngine();` (importing `unassignedEngine` from `./engine-next.js`); on its branch the leaf reads as one above the highest landed engine. The landing merge writes the next number into the leaf, in landing order, inside that item's merge commit, and sets the `move engine` row above to the highest landed number. A landed number never changes, so recorded moves replay as they were written. Moves are recorded under landed numbers only: code with an unnumbered engine is for its branch's own tests, and a move it records on a real board before landing may later read under another item's number, so the item lands before its moves are used.

Engine 130 (`MECHANICAL_MERGE_ENGINE`) gives new automatic conflict returns version-two `computedConflict` receipts. Health, fresh conflict returns and landing share conservative mechanical decisions: structural JSON retains independent additions and unchanged-value removals, jointly raised numeric counters keep the larger value, and add-only text unions must pass a syntax-only check for JavaScript. Health classifies declared generated `apps/cli/src/logic/help/additions.js` without executing item code; only landing runs its generator in the merged tree before its gate. A failed generator blocks with `LAND_MERGE`, naming the item, file and generator, rather than reopening accepted work as a conflict. Version-one receipts continue to verify their original plain-Git conflict paths on replay; version-two receipts verify mechanical conflict paths. The receipt version is part of the immutable-object cache identity. Fresh authors cannot reuse version-one semantics, and a version-two receipt requires engine 130 before changing a board or replay cursor.

Version-three conflict receipts additionally recognize source-generated API and formats tables, full CLI help and its browser-safe command additions. `GENERATED_DOCS_ENGINE` is their replay floor. Versions one and two keep their original conflict policy, even when version three can regenerate a newer output. Narrative conflicts remain ordinary conflicts; automatic generation never discards competing prose edits. Health and replay inspect immutable bytes only, while landing runs the candidate generator before the gate.

Relay transport capability `apiVersion: 2` is independent of these versions and
of the unchanged `version: 1` HTTP envelope and seal envelope. API2 uses
`pullboard-paged-snapshot/1` inside encrypted directory pages, with a current-state
presentation below 900,000 bytes, full current fields, native tables and keyed
item/shout history references. Each sealed object is content-addressed by the
SHA-256 of its ciphertext; plaintext blocks are at most 262,144 bytes, ciphertext
at most 400,000 bytes and descriptor fanout at most 64. Devices validate bounds,
board/sequence binding, range counts, ancestry and the complete restored native
shape. The relay validates only the opaque graph. Its journal format 4 migrates
formats 2 and 3 in place and stores pages in the same SQLite backup as the
current root. Old API1 clients explicitly refuse an API2 head with upgrade
guidance. A private device-only page cache stores no board key or plaintext
record; its fingerprints and hashed session-notice receipts never cross HTTP.
See [the operator protocol](../relay/README.md#paged-snapshots-and-account-storage).

Pullboard 0.6.1 released engine 1. Engine 2 records a fresh explicit-build claim's skipped-review snapshot. Pullboard 0.8.1 released engine 3, including lane-sensitive graft refusals and authenticated relay senders. Engine 4 adds captured background-baseline completions through `completeCheckBaseline`; released engine-3 clients stop with `ENGINE_VERSION` before interpreting this new operation or advancing their replay cursor. Engine 5 requires a one-line reason when releasing a review and gives that reviewer a one-hour cooldown for the current submission. Each sealed move replays under its recorded engine version: engines 1 through 4 retain the original release event and review-reservation behavior. Engine 5 retains support for older moves, including engine-4 baseline completions. Pullboard 0.8.3 released engine 6, adding board-scoped machine credentials and permitting machine execution only for one exact, earlier authenticated phone request, including its payload digest. Engine 7 adds ordered item holds through `holdItem` and `releaseItemHold`; engine-6 clients stop with `ENGINE_VERSION` before interpreting either operation or advancing their replay cursor. Engine 8, shared by the 0.8.5 move changes, retains merged-item exception notes, selects the next review in roadmap order, and adds coordinator-only `reopen` for a submission returned without a verdict; engine-7 clients stop with `ENGINE_VERSION` before interpreting this new operation or advancing their replay cursor. Recorded engines 1 through 7 retain their original tier-first review selection. Engine 8 also adds durable refusal recovery for blocked relay positions; each explicit skip publishes the readable prefix even when another unsupported record follows. Engine 8 also permits coordinator criterion/check edits on a live claim as pending corrections; the holder cannot renew or submit until a refreeze adopts the correction while preserving the claim. Older request receipts retain their recorded engine semantics. Upgrade every linked device before using the new moves. Each release shares one engine bump across its changed moves. Engine 8 also retains declared model labels on registration and records each registered agent move's model snapshot; engines 1 through 7 retain their original registration and event details without these model fields. Pullboard 0.8.8 released engine 9, which allows resubmitting the same rejected commit after a corrected criterion is refrozen, but only when the rejection names a different frozen digest. Engine 8 retains its HEAD_NOT_NEW refusal and prior submit-event detail. Engine-9 submit events add `criterionDigest`, and engine-8 boards replay with the original refusal and event history.

Engine 10 adds coordinator-only reopening for an unmerged verified item after a red landing candidate. Its append-only `reopen` event names the superseded accept, failing test and landing merge commit; the original accept and verdict remain in history. Engines 8 and 9 retain their submitted-only `reopen` behavior: a verified-item reopen is refused without changing the replayed board. Only engine 10 may return a verified item to open, with a failing test and landing merge commit in the note. Dependency edits also require engine 10: an `editItem` move with `after`, including `after: []` to clear dependencies, cannot be replayed under an older engine. Ordinary edits without `after` retain their historical behavior. Older clients refuse an engine-10 move before changing their board or replay cursor; upgrade Pullboard before sending or applying dependency edits.

Cross-repository prerequisites (B24) extend the existing comma-separated `item_after` text with exact `repo#id` references; local entries remain numeric item IDs. The foreign repository is the child handle on exactly one current, unrevoked signed two-sided E32 link whose parent is this board. Only that link generation's authenticated received `states` announcement can satisfy the dependency. Missing, ambiguous, undisclosed or non-verified foreign state stays blocked. Machine project paths, registry entries and caller-supplied status snapshots do not establish verification. Claim and next use the same canonical state on replicas. Add/edit carrying a foreign reference, and claims of such an item, require the cross-repository dependency engine floor in addition to all existing applicable floors. Foreign item IDs never enter local Git merge, lane inheritance or local dependency traversal.

Engine 11 permits resubmitting the same commit after a coordinator no-verdict reopen only after the frozen bar is explicitly refrozen, or an edit clears the frozen bar and a new claim freezes it again. Reopening without a later bar change still refuses the same commit, and a rejection at the current frozen digest continues to require new work. This rule does not apply to a verified-item red-landing reopen. Engine 10 retains its earlier same-commit refusal for no-verdict reopens.

Engine 12 records declined person row decisions without replacing the exact source text: the row becomes `wont` and the reason stays in the decision record. Engine-11 decline receipts retain their original reason-as-row-text validation and replay outcome. Engine-11 clients refuse engine-12 moves before interpreting them; upgrade linked clients before recording new decline decisions.

Engine 19 makes a corrected bar record why the old one was wrong. Once an item has ever been claimed, an `editItem` that changes its criterion or check must carry `reason`, the text of what the old bar got wrong; without one it is refused with `BAR_REASON`, naming `--reason`. The edit event then records `reason` and `barCorrection: {fields, reject}`: `fields` lists `criterion` and/or `check`, and `reject` is `{verdict, by, reason, at}` when the item's newest verdict is a reject no earlier correction already explained, or `null`. That reject is counted as caused by the bar. The board derives `barCorrection` from its own rows; a move supplies only `reason`. An edit before any claim needs no reason and records one only if given. `pullboard stats` JSON adds `bars`, keyed by agent: `{corrections, barRejects, buildRejects}`. Corrections and the rejects they explain count to the agent who corrected the bar; any other reject counts as the build's, to the agent who added the item. An `editItem` move carrying `reason` requires engine 19, and older engines refuse it with `RELAY_MOVE` before changing their board or cursor. Moves recorded under engines 18 and earlier replay without the reason rule. Trunk skipped engine numbers 13 through 18. A later engine change takes the current trunk's next number, keeping every earlier recorded engine's replay unchanged.

Engine 33 binds a review to the immutable submitted commit, the exact checked composition, its reviewed trunk and sorted candidate paths. A stale, unmerged acceptance can be re-reviewed without rewriting the submission; landing uses its accepted checked composition. New review metadata and landing batches carrying `reviewedCommit` require engine 33, including later updates to those batches. Previously recorded outcomes replay before this state-dependent version check, and previously released engines retain their original review and landing behavior. Older clients refuse engine-33 moves before changing their board or replay cursor; upgrade linked clients before using checked-composition reviews. The coordinator assigned engine 33 to this change. Merge the actual trunk before landing.

Engine 20 lets a decision name the items it changes. An `appendFact`, `answerDecision` or `verify` move may carry `implies`, a list of existing item ids, and an `answerDecision` move may carry `supersedes`, the shout id of an earlier answer. Either makes the move an engine-20 move: an older engine refuses it with `RELAY_MOVE` before changing its board or cursor, and a board replaying an older engine refuses `implies` with `ENGINE_VERSION`. Engine 20 also tells implied items when a decision is superseded: by a fact's `supersedes`, by an answer's `supersedes`, or by the next verdict on the same item. Moves recorded under engines 19 and earlier replay without these notices. Engine numbers 13 to 18 are allocated to other changes; whichever lands later renumbers, keeping every earlier engine's replay unchanged.

Engine 24 adds the person's `acceptCheck`: an item's current check, named by its SHA-256 digest, accepted so a check already green on main no longer holds the item on a board whose `checks.provesNothing` is `"hold"`. Only the person may send it, from the terminal or the view; the relay refuses it from an agent or a machine. A move from an older engine is refused before it changes the board or replay cursor, and older clients refuse engine-24 moves before interpreting them. Engines 21 through 23 are allocated to other changes.

Engine 30 lets a reject and a reopen carry a cause key (`cause`: `test:<file>::<title>`, `refusal:<CODE>`, `row:<id>` or `doctrine:<id>`) and lets the person record a never-again fact with `cause` and `neverAgain: true`, for `pullboard rigor`. Only a move that carries one of these needs engine 30; engine-29 and older moves replay unchanged, and clients on an older engine refuse an engine-30 move with `RELAY_MOVE` before changing their board or cursor. Engine 20 is the implied-items engine above; engine numbers 21 through 29 are allocated to other changes.

Engine 48 records on each new seat the seat that created it (`createdBy`: an agent id, or `machine` for a join no seat made), lets a creator name the new seat (`id`), and applies verifier standing to relay-replayed verdicts, review reservations and offers on a linked board: the verifier's line of creating seats must reach the coordinator through seats enrolled by the relay, without the builder or a machine join. Replicas apply a register move by another seat only with the relay's receipt for its target, creator, position and digest. The relay stamps every record it stores with `policy: 48`; a stamped move below engine 48 is refused. Engine-12 and older moves, and unstamped records, replay as they did. On an unlinked board who may verify is unchanged.

Engine 38 records submission test selections and normalized landing evidence. A `submit` carrying `submissionProof` or a `recordLandingBatch` carrying `invariantEvidence` requires engine 38; earlier engines refuse these envelopes before applying them, and a missing or malformed proof is refused with `SUBMISSION_PROOF` on a modern submit before its item or events change. Moves recorded under engines 37 and earlier replay without inferred coverage. Known-main failure receipts retain their exact main commit, project test file, case name and diagnostic signature. The `KNOWN_MAIN_REWORKS_ENGINE` extension also requires a positive repair `item` on every failure, revalidated against the unique open repair in the ordered submit. A linked envelope requires that feature engine; historical engine-124 receipts replay in their original unlinked format without inferred repair ownership. Recorded invariant evidence is append-only when a landing batch is adopted; adopting or finishing a batch already carrying that evidence requires engine 38, even when the incoming move omits the evidence field. Engine slots 25 through 37 are allocated to earlier train changes; preserve their semantics when composing this item.

Engine 45 gives a milestone a target and a shipment. An `editMilestone` move may carry `target`, an ISO date or date-time with an explicit zone (the CLI and `prepareEngineMove` turn a typed local time into UTC before the move is sealed, so every replica stores the same instant; a bare local time in an envelope is refused with `MILESTONE_TARGET`), or `none` to clear it. A `shipMilestone` move records the milestone as shipped at main's commit and moves every local item that has not landed and is not withdrawn into the next unshipped milestone, or `--next`, writing a `milestone_moved` event on each moved item; repo-qualified references stay in place and are listed as not moved across boards. A shipped milestone refuses new items with `MILESTONE_SHIPPED`. Either makes the move an engine-45 move, and an older engine refuses it with `RELAY_MOVE` before changing its board or cursor. The coordinator assigned engine 45 to this milestone feature; each other feature retains its separately allocated engine minimum. Engine 30 carries the cause-key behavior above; engine 33 retains the checked-review behavior described above.

Engine 50 automatically advances a rejected item one route after two REJECT verdicts on the current route. A release is not a rejection; a manual escalation or an actual route edit starts a new count. The existing escalation event records both rejection receipts. The strong route remains the ceiling. Moves below engine 50 retain their earlier behavior and do not automatically escalate. Upgrade linked boards before using automatic rejection escalation.

Engine 51 writes #649's withdraw-and-remove milestone behavior. A withdraw move is followed by one ordered `editMilestoneItems` removal for each local milestone that lists the item; previous withdraw records retain their original replay, and an older client refuses the new engine before applying any move. `WITHDRAW_MILESTONE_ENGINE` is 51; `MILESTONE_SHIP_ENGINE` remains 45, so milestone targets and shipment keep their engine-45 meaning. The roadmap projects remaining-to-ship work before verified items and omits withdrawn items from its list and total while reporting them separately.

Engine 42 adds ordered `recordHealthFindings` observations. A scan retains its board event revision, emits new and resolved sentinel notices once, and records `health-failure` receipts under their refusal cause keys. Rigor counts repeated health episodes without inventing a changed code commit. Older engines refuse this operation before replay; earlier move meanings and feature minima stay unchanged.

Engine 52 reopens an accepted item that conflicts with the trunk for a main merge. A `reopen` move may carry `conflict: {files, trunk}`: the files that conflict, and the full trunk commit they conflict with. The CLI takes one exact path per `--conflict <file>` flag and splits or trims nothing inside it, so a path with spaces or commas is named as Git reports it in `git merge-tree --write-tree --name-only -z`; `files` holds those exact paths, nonempty and without NUL. The CLI fills `trunk` from Git and refuses `NOT_CONFLICTING` when the accepted commit merges cleanly, or `CONFLICT_FILES` when a named file is not one Git reports as conflicting. The board refuses `NOT_ACCEPTED` unless the item is verified with an accept at its commit, and `BAD_CONFLICT` for a malformed conflict. A conflict needs no note and no landing failure; the event records `supersedes`, the accept it sets aside, `conflict`, and `cause: "refusal:MERGE_CONFLICT"`, never `landingFailure`, so rigor counts it as a merge conflict and never as a failing test. The item reads `needs main merge` until its next verdict, and the re-review checks the frozen check at the new head. A `reopen` move carrying `conflict` requires engine 52, and older engines refuse it with `RELAY_MOVE` before changing their board or cursor; a board replaying an older engine refuses it with `ENGINE_VERSION`. Moves recorded under engines 51 and earlier replay unchanged. The unlanded feature’s previous allocations were 36 and 47; it moved to 52 after the trunk reached engine 50 and milestone withdrawal was allocated engine 51, preserving every landed feature’s engine.

Engine 55 (`ROW_DRAFT_ENGINE`) adds `draftSpecRow`: an agent in a lane worktree records a drafted spec row on the board, since SPEC.md is the coordinator's file and a lane cannot write it. The move carries `row: {id, text, gate, tier, section, target}` and `written`. Every writer of a new row reserves its id with this move, in one write transaction, before any file names the id: a lane's spec draft, the main checkout's spec draft and doctrine rulings, Rigor and blueprints. The sender plans the id from its files; the board takes that id or the next number after it that no draft holds, so writers that planned the same id at the same moment get distinct ids, and the same row again keeps the id it reserved. `written: true` marks a writer that puts the row in its own file now; only unwritten spec drafts, which come from lanes, are written by spec apply. Until spec apply writes it, the commit-msg hook and `spec check` read a board draft as a draft row, so a lane cites the returned id at once and its worktree stays clean. The coordinator's `spec apply` writes each pending board draft into SPEC.md at its own id, and the person approves it there as before; a draft counts as applied once SPEC.md has its id. A move carrying `draftSpecRow` requires engine 55, and older engines refuse it before changing their board or cursor. Engine 54 is the strong-rejection notice above; engine 53 was reserved for unshipped board watches, now allocated engine 56 because engines 54 and 55 shipped first.

Approved-row revision proposals use `row_drafts` entries with `revises`, `file`, exact `source` and `replacement`, proposed `status`, and `reason`; they are never materialized as new SPEC rows. The `decideSpecRevisions` operation accepts only the authenticated person channel and the exact pending proposal. An approval records a normal target-row decision with a canonical signed `revision` reference (proposal id, target, file, source, replacement, reason and proposer). A decline records the disposition without replacing the target's existing approval. Proposal dispositions retain their decision event and person attribution. Revision-bearing drafts and decisions, and the new disposition operation, negotiate the revision engine floor; older readers refuse before changing the board or cursor. Ordinary historical row-decision signatures keep their original canonical bytes.

Engine 56 (`BOARD_SENTINEL_ENGINE`) adds board-owned watch proposals, exact person approve/decline decisions, ordered due-run claims and completed run receipts. Approval binds the entire execution definition; changing it creates a pending proposal. Replay records history without executing commands. Every non-cancelled red run records `sentinel:<name>` for Rigor; feed notices only mark failure and recovery transitions. Older engines refuse these operations and this new cause form before replay. Published engine-55 readers reject these moves by their newer engine number before interpreting an operation.

The board's committed `flakes.rerun` setting defaults off. Off retains released execution, including landing's whole-file diagnosis and first legacy `landing_flake`; the new ledger still records the original failure. On permits one exact-target diagnostic for a supported structured Node test at unchanged source, never green-by-retry. Built-in `node --test` is supported; a `apps/cli/src/io/run/tests.js` script is recognized only when its committed bytes on candidate and pinned main match the bundled Native runner. Its filename alone does not establish selector support, and a probe that executes other targets remains unclassified. A pinned green main marks a possible regression, not a flake. Unknown selectors, source changes or unsupported remote execution evidence remain unclassified; no local substitute is run for a remote admission. A confirmed second sighting drafts an ordinary strong repair item, not an approved spec or doctrine row. A landed repair reads fixed until another sighting. Enabled landing consumes its captured pair without another legacy diagnosis or first-sighting legacy defect; saved typed relationships prevent remeasurement on adoption. Diagnostic-recording failures are reported while the original red and completed evidence remain retained. Older engines refuse the new operation and typed landing relationships before changing rows or the replay cursor; legacy `landing_flake` meaning and the schema/event-log versions are unchanged.

The board's committed `rigor.budget` setting is the number of lines of non-test code one change may add, net, before `pullboard rigor quality` names it under its size-budget rule; it defaults to 400, and `--budget` overrides it for one run.

Engine 60 (`SUBMITTED_CONFLICT_ENGINE`) lets a conflict reopen return a submitted head, not only an accepted one, and lets any joined seat record it. Before it offers a review, `pullboard next --verify` merges every submitted head onto the trunk in memory, as landing does; a head that conflicts goes back to its builder, open and unreviewed, with Git's conflicting files and the trunk commit, and its builder is told which files and that the one step back is to claim it, merge main and submit again. The reopen sets no accept aside and records no verdict; its next review is a whole one. A hand-written `--conflict` on a submission, which names no trunk commit, is still refused. Engines 57 to 59 are allocated to other changes; older engines refuse this move before replay.

Engine 61 (`NATIVE_FLAKE_ENGINE`) adds `recordFlakeObservation` and typed diagnostic relationships in landing-batch receipts. A registered reporting agent supplies a bounded observation: stable id, relative test file/name (or null when unknown), pinned head/tree/main, gate kind, classification, observation time, machine-load sample, diagnostic duration, command digest, and original/paired/main receipt references. A receipt contains its result, byte count, SHA-256 and optional profile digest; full raw output and profiles stay under the common Git directory's `pullboard/flake-evidence/<id>/`, outside board events. Those local artifacts are not automatically copied to another device by a board snapshot. A duplicate observation id returns the original receipt; different evidence under that id is refused. The original red remains authoritative.

Engine 62 (`HEALTH_CAP_ENGINE`; engine 61 is #887's) caps what one recorded health run shouts. A run sends at most ten notices one by one, resolved first; when it has more, one more notice to the coordinator says how many it held back, and every finding still records its own health event. An idle seat alone hears that it is idle. A recorded run at an older engine replays with its original notices.

Engine 63 (`RECURRING_JOB_ENGINE`) records recurring jobs. `declareJob` is the coordinator's or the person's: it stores a job's name, its cadence (`10m`, `2h`, `1d`, `hourly` or `daily`) and its owner, and a later declaration replaces the cadence and owner but keeps the run history. `recordJobRun` is any joined seat's and stores the job's name. Both events carry `engine: 63`. `pullboard health` reports a job with no run within one and a half cadences as `JOB_MISSED`, once per episode. An older engine refuses both moves with `ENGINE_VERSION`, and a replay at an older engine ignores their events.

Engine 64 (`LOCAL_LANDING_ENGINE`) lets a landing batch reach the state `trunk`: merged onto the local trunk after its quick guards (the static checks and submit invariants), with each item's merged receipt recorded before anything is pushed. Only a board whose `pullboard.json` sets `landing: { "publish": "separate" }` lands this way; `pullboard publish` then runs the whole suite on the exact trunk head and pushes only a green head. A batch recorded at an older engine still needs `pushed` before its receipts.

Engine 65 (`CI_FLAKE_ENGINE`) records flake observations imported from CI with `pullboard flakes import <folder>`. Such an observation has kind `ci`, a `ci` record (provider, run id, the failed attempt and its rerun attempt, job, runner and Node version) and a `load` of null, because a hosted runner reports no host load. A failed attempt whose rerun at the same commit passes the test is a flake; one whose TAP names no test by file stays unclassified. Observations of the other kinds replay as at engine 61.

Engine 66 (`REOPEN_FIRST_REFUSAL_ENGINE`) holds a reopened item for its builder. With `claim.reopenFirstRefusalMinutes` above zero, a reject, a landing failure or a trunk conflict records when the item came back, and for that many minutes only its builder may claim it; another seat's claim is refused with `REOPEN_HELD_FOR_BUILDER`. Older engines replay those moves without the window.

Engine 67 (`GATE_RUN_ENGINE`) records gate runs and the flake quarantine they prove. The gate writes a receipt for each real run of the accepted gate command on a clean, committed tree, under the common git directory at `pullboard/gate-receipts/<id>.json`: its id, kind (`gate`, `submit` or `land`), tree, head, accepted main, the command's SHA-256, its result, the committed file and name of each test that failed, the host load and the time. The writer is private to the gate and takes the result from the process it just ran; a run of any other command, or one whose checkout was dirty or moved, leaves no receipt. The coordinator's gate runs, from the main checkout and the landing, go on the board as `recordGateRun`; a seat's run keeps only its receipt. `recordGateRun` carries that receipt, and both a direct call and a sealed move are refused (`GATE_RUN_UNBOUND`) unless the store beside the board holds the same receipt byte for byte, so a run made up by hand is never recorded. A replayed move is applied as its origin checked it. When the coordinator's runs have found one tree both red and green for the same test, the board files one ordinary repair item for that test, with the runs as evidence, and records a `test-quarantine` event; a run any other seat recorded proves nothing. Quarantine itself is the coordinator's `flakes.quarantine` setting in pullboard.json, read from accepted main and off by default: with it off, runs and the repair item are still recorded, but nothing stops blocking a landing. With it on, a quarantined test still runs and reports, but a landing treats it as covered, like a waiver naming that file and test, as long as every run that proved it is a receipt on the landing machine and its repair item is not verified or withdrawn; it then blocks again, and only a newer red-and-green proof files a new item. A different red in the same run is never covered. An older engine refuses the move with `ENGINE_VERSION`.

The relay outbox lives beside `relay.json` as `relay-outbox.sealed`, mode 0600, sealed with the board key under the `outbox` seal kind at sequence 0. It is enabled by default; committed `relay.outbox: false` opts out. Inside is gzip JSON `{version: 3, baseSequence, restored, moves, results}`: `baseSequence` is the relay sequence the queued moves sit on, and each move is `{move, refs, intent, queuedAt, after, sequences, changes}` with the prepared engine move, the relay sequence this machine had seen, the board's `sqlite_sequence` rows just before the move, and the base64 SQLite changesets of the rows it changed here. An outbox written before #1013 is version 1 or 2 and also holds `base`, the native board image at `baseSequence`, and is replayed from that image until it empties. Its key-free summary, the list `pullboard status` shows, is `relay-outbox.summary.json` beside it, and `relay-outbox.generation` counts every move ever queued there; `relay.json` keeps the last twenty `outboxRefusals` and `outboxRenumbered`, never the summary. A replay reads every record the relay ordered after `baseSequence`, then rebuilds the board in one step: it takes the queued moves back by their inverted changesets, newest first, with the lifecycle triggers lifted in that transaction only, and puts `sqlite_sequence` back (keeping each seat's newer shout-read position); applies those records; settles each queued move whose receipt is now on the board; and makes the moves still queued again on top, capturing their rows afresh. When the moves cannot be taken back row for row, the relay's checkpoint stands in, if it is no older than `baseSequence`. Only then does it send the moves still queued, each at the next sequence, and read again. The outbox adds no engine version: every move still replays through the relay's order.

Local first (#1013, H21): on a board whose baseline the relay accepted, ordinary authorized moves queue themselves in the outbox and are made on this machine at once, with no network call. `register`/`ensureCoordinator`, `takeover`, landing-fence operations and person requests remain acknowledged authority exceptions; those may wait for relay authorization. An explicit relay canary (`io.relayCanary`) also requires acknowledgment, because it measures the relay. All moves in environment-token sessions remain relay-acknowledged too: an ephemeral CI or cloud job cannot retain queued moves after it exits, so only persistent person and agent devices use local-first. `relay-outbox.guard.sqlite`, beside the link, is held in an exclusive SQLite transaction while a move queues and while a replay rebuilds the board, never across a network call. A refusal found at replay is also left for the worktree of the agent that made the move, as one JSON string per line in `relay-conflicts/<digest>.txt` (the first 32 hex of the SHA-256 of the worktree path), which that worktree's next command prints and removes. One background sender per machine does the relay's work, under `relay-sender/` in the machine's pullboard home: `sender.pid` is its claim (refreshed while it runs), `sender.starting` marks one being started, `sender.log` is its short log, and `boards/<digest>.json` is `{root, file, due}` for each board a command nudged, named by the first 32 hex of the SHA-256 of the link file's path.

Engine 69 (`REVIEW_SKIP_ENGINE`) lets `reserveNextReview` carry `skipIds`: the submitted items the reviewer's own agent session built, which `pullboard next --verify` never offers it. A move with a non-empty `skipIds` needs engine 69, so an older reader refuses it instead of reserving a different item; moves without `skipIds`, and every move recorded before engine 69, replay as before.

Engine 72 (`COORDINATOR_HOLD_ENGINE`) holds a linked board's coordinator at one main checkout at a time. Each linked main checkout sends its coordinator moves under its own root coordinator credential, whose lineage the relay authenticates. The board keeps the holding lineage in `board_meta` as `coordinator_holder`, with the holder's name, `computer` and the end of its relay machine id. The first coordinator move at engine 72 takes the hold; a later one from another lineage is refused with `COORDINATOR_HELD`, naming the holder. Registering seats and recording the coordinator's path stay open to every linked main checkout. `takeCoordinator`, sent by `pullboard takeover` in a linked main checkout, moves the hold to the sender and logs a `coordinator-takeover` event naming both holders. Moves recorded before engine 72, and every move on an unlinked board, replay as before.

Engine 73 (`PEOPLE_ENGINE`) names people and lets approvers alone act as the person. The relay stamps each stored record's sender with the GitHub login behind it, the engine the sender declared and, on a board that names approvers, `approver: true|false` for a person sender. Replaying a move made at engine 73 or later, every event it writes carries `person`, that login, beside `event_by`, the agent or seat. A move that carries out a recorded phone request carries the request sender's login instead, and a `relay_refused` event carries the login of the person who tried the move or request. `pullboard.json` may list `approvers`, GitHub logins, at most fifty; leaving it out keeps today's behaviour. On a board that names them, every replica refuses with `NOT_APPROVER` a person move (a row or sentinel decision, an answer, hold or fact as the person, a person request shout) or a phone request to answer, hold or decide rows whose sender is not an approver, and the relay refuses an unlink or snapshot replacement from anyone else. A record whose seal no key opens, from an engine no newer than the replica's, is set aside as `relay_refused` with code `RELAY_SEAL`, and replay goes on; one from a newer engine still asks for an upgrade.

Engine 74 (`LANDING_LEASE_ENGINE`) gives a trunk one landing at a time (#417). The `landingLeaseMove` operation takes, renews and releases the board's landing lease, carrying the holder's token, branch, pid, generation and guardian. `recordLandingBatch` and `finishLandingBatch` may carry a `landingFence` that names the lease they write under; a write whose fence is not the current holder's is refused. A second `pullboard land` names the holder and queues. Older engines refuse `landingLeaseMove` and any fenced landing write, and a landing lease move never falls back to a local preview or a queued relay move: it needs an acknowledged order.

Engine 80 refuses a review, a review reservation or a next --verify offer to any agent or session that ever claimed or submitted the item, not only its current owner (#1085). Older engines replay their recorded reviews under the owner-only guard they had.

Engine 85 (`LANDING_ENVIRONMENT_ENGINE`) records the actual executor's exact `{platform, arch, node}` on new machine-run verdicts and gate receipts. An explicit `null` means unknown; historical receipts without the field keep their original canonical bytes and replay semantics. Landing batches retain their executor and flag accepted verdicts from a different or unknown environment. Earlier engines refuse moves carrying these fields before applying them.

An optional `landing.environment` in `pullboard.json` requires all three exact fields. The matching machine must also opt into this board with `pullboard settings landing.pool on`; `off` removes its opt-in. Machine settings store the board IDs in `landing.pools`. A constrained landing runs on that matching, opted-in coordinator host; generic SSH runners are not members of a board's landing pool. Omitting the policy retains normal runner selection. A mismatch is refused before creating or gating a batch.

Engine 85 also adds `recordLandingTestDefect`. A red batch whose bisection finds no item culprit records a neutral repair item and a `landing-test-defect` event with its test path, content hash, red-tree blob, original trunk blob, failure names, batch ID and trunk branch. Its batch remains `test-defect`, and further landings on that trunk stop before another gate runs. A committed correction to the test on the trunk, or live existing waivers covering every recorded failure, releases the hold. Candidate-only changes and uncommitted edits do not release it. A waiver keeps the red tree and its waived failures explicit. Existing culprit and flake diagnosis retain their meanings; older engines cannot revise or finish a batch carrying these fields.

A later `closeLandingTestDefect` move records a `landing-test-defect-closed` event (`closed`: trunk branch, test path, repair item and trunk commit) when a landing finds the defect's recorded failing cases passing in a recorded run at the trunk commit. The closed defect no longer holds landings at later trunk commits; a new red of the same cases files a new defect that holds the trunk again. Older engines cannot apply the move.

Engine 90 records the parent session a seat joined under and stamps each verdict with its assurance: independent when the builder's and reviewer's recorded parents differ, procedural when either is unknown (#1102). Review eligibility, next and the queue exclude any seat sharing a parent with an author. Older engines replay their recorded verdicts with no parent recorded.
The unassigned signing engine (`PERSON_SIGNING_ENGINE`) signs person moves with a passkey. `setPersonSigning` records a `person_signing` event: anyone may turn signing on, and turning it off is the person's move, carrying out a request whose relay stamp and exact document the event keeps as `request`, `presence` and `intent`; an off counts only when that document turns signing off and its digest is the one the stamp signed. `proposePersonMove` records a terminal-started person move as a `person_proposal` event and keeps the exact request in `board_meta` as `person_proposals`, for the passkey device to show; it grants nothing. While signing is on, every replica refuses with `PERSON_SIGNED` a person-only move (a row or sentinel decision, an answer, hold, fact or waiver as the person, or any move the person makes) unless it carries out a recorded phone request whose sender carries the relay's passkey stamp; that request's claim, refusal and coordinator-request receipts still pass. Older engines refuse both moves with `ENGINE_VERSION`, and moves recorded before signing was turned on replay as before.

`BAR_READY_ENGINE` introduces ordered `setBarReady` and `signBar` moves; its unassigned leaf is numbered by the landing merge. Readiness defaults off. `pullboard bar ready on` is coordinator-only and snapshots already-frozen bars, which remain grandfathered until their words change. Older engine moves retain their recorded behavior. Enabling readiness makes later bars require an observed main-red named case (including an absent named case), `Named test:`, `Measurements:` and `Reviewer edges:` sections, and an outside-parent signature. Section presence is enforced; the signer judges whether the methods and edge cases are adequate. The named-case witness currently reads captured TAP or JUnit case records with per-case timing. Configure the project’s own reporter to emit those records to the captured output; a pretty summary or an XML file that is never emitted does not establish a named failure. Unsupported output remains unknown and refuses readiness, rather than inferring a named failure from the process exit. This opt-in evidence requirement does not change ordinary workflow with readiness off.

Semantic add/edit moves capture the current native author session and parent in their ordered arguments, preserving authors of unchanged fields. Signing likewise captures the current signer; replay never consults a replica's environment. A current session's explicit joined parent is used when native parent metadata is unavailable. Taking over a known helper seat without current parent metadata refuses rather than declaring that helper independent. Unknown historical agent identities cannot establish independence. The authenticated person has `authority: "person"`, with null session and parent, and is a distinct authority: an agent may sign a person-authored bar and the person may sign an agent-authored bar. Unknown agent authors still fail closed. Terminal person actions use `--as person` on `add`, `edit` or `bar sign`; the authenticated coordinator view records that authority directly. Ordered transport selects person credentials for this provenance, while retaining normal agent credentials for agent authors; no parent is invented for the person. These captures do not rewrite historical seat identity. Each `bar-revision` event binds the exact title, criterion, check, brief, citations, dependencies and route; `bar-sign` additionally binds its event revision, baseline digest, coverage plan, author parents, signer and note. Editing away and back still requires a new signature. Additive `board_meta` keys `bar_ready_setting`, `bar_grandfather:<id>`, `bar_revision:<id>` and `bar_sign:<id>` hold the current indexes; the events retain history.

`pullboard bar sign <id> --coverage-file <json> --note "..."` records whole-file obligations for existing committed test files in the brief's `Files` list. `claim.barTestFiles` defaults to Node test/spec filename globs; projects can explicitly provide their own globs. The file supplies `files: [{path, mode: "whole"|"landing", evidence}]`, a `named` observation, and an install observation when accepted main configures an install. Each observation retains `durationMs`, `selection` (`whole-file`, `named-check` or `install`), `ref`, `sha256`, full source commit, runtime and outcome. Whole mode requires a completed green whole-file observation. Landing mode requires a recorded whole-file duration exceeding the unchanged available review budget, explicit landing coverage in the brief and retained `namedCases`; unknown or named-only durations cannot establish that exception. Named, install and appended whole-file durations must fit the existing timeout together. References and hashes are signer-attested metadata; Pullboard validates their shape and budget, and does not independently open evidence artifacts during replay or prove the accuracy of a signer's account.

Accepted main determines the test inventory, `affectedTests` runner, install and timeout. A changed inventory or execution policy requires a new signature; unrelated main changes do not. The frozen criterion retains `sourceCheck`, `barCoverage` and `barRevision` and one effective `check`: the original shell command, grouped intact, followed by the project's own runner over signed whole-file paths. Check, submit and verification consume that same frozen command; Pullboard adds no framework or test suite to another project. With readiness enabled, normal submission also requires a committed candidate containing the exact current main used for its proof, unchanged through execution; `MAIN_NOT_COMPOSED` names the merge-and-submit recovery. Unrecorded recovered submissions cannot reuse proof from an older main snapshot.

The CLI declares its engine in every relay request's `X-Pullboard-Engine` header.
A linked board requires at least engine 48 after issuing any agent token or machine credential, including
revoked or expired ones; before engine 48 these minimums were 3 and 6. The minimum survives reopening the auth database;
unlink removes the board and ends its lifetime. A missing declaration is legacy
engine 1. Board-content requests below their minimum, and malformed declarations,
receive `ENGINE_VERSION` with upgrade guidance before records are returned or
changed. The service checks again under its board lock and on live-stream polls.

Engine 3 checks each move or request against the relay's authenticated sender before replay. An agent token acts only as its named agent and cannot act as the person. Refused attribution attempts advance the sequence with a `relay_refusal_<sequence>` receipt and a `relay_refused` event naming the sender, attempted actor and refusal code. They change no item, shout or verdict and do not reserve the forged operation id. Snapshot restoration requires an authenticated person or board machine sender. A machine can register ordinary agents and ensure the coordinator; other person effects require an earlier authenticated phone intent with exact operation, arguments, target and digest. Every replica consumes its execution once, including row decisions waiting for repository application. Receipt shouts have fixed text; refusal details remain in the structured request result. The event log remains version 1.

A board without `event_log_version` is a legacy version-0 event log. Opening an older board writes the current marker without replacing its events. Opening a newer event log refuses with `EVENT_LOG_VERSION`, naming the stored and supported versions and asking you to upgrade Pullboard. `doctor` reports that version conflict read-only. Turning signed person moves on raises the board to format 2 in the same transaction, and an import or checkpoint restore whose events include `person_signing` does too, so a Pullboard from before signed person moves refuses the board instead of ignoring them. Ordinary boards stay at format 1.

The `job` and `job_step` tables are part of a board export only while they hold rows: an export of a board with no jobs leaves both tables (and their `sqlite_sequence` counters) out, and an import treats a missing `job` or `job_step` table as empty. Every other table must be present exactly. Import reports the tables the export carried, so its `tables` list equals the export's table names.

A native board export includes the marker in its `board_meta` rows. Import refuses a newer event-log version before changing the destination; an older export upgrades its marker in place. Static view exports put `eventLogVersion` beside the data in both `state.json` and `events.json`, separately from the API envelope's `version`.

Linked clients seal an executable operation and its deterministic inputs. The relay assigns its sequence and receipt timestamp without reading the operation. Each client runs the CLI's board engine at that timestamp. Successful results and engine refusals advance `board_meta.relay_applied_sequence` in the same transaction as the move's receipt, keyed by `relay_receipt_<operation-id>`; retries return the recorded outcome. An identical operation id and descriptor at a later relay position advances the prefix without another event and returns its first outcome. The same id with different contents is refused with `RELAY_MOVE`. `relay_engine_version` records the checkpoint's executable semantics. A future engine stops replay before either its rows or its cursor changes.

A sealed checkpoint keeps the native export tables importable and may carry the local API presentation beside them. Its public sequence equals `relay_applied_sequence`, so clients can restore a compacted prefix and continue after it. The older local-first mirror drains only its already-durable outbox, then publishes a checkpoint covering the acknowledged prefix without executing those events again. A divergent old outbox is refused with the relay and local sequences; re-link from that machine or join by pairing.

For ordered sealed relays, ordinary `pullboard relay` stops at an unsupported future move-engine or seal-envelope version. It leaves the blocked sequence and native board unchanged so an upgraded client can replay it. A person in the main checkout may explicitly run `pullboard relay recover --skip N` for the exact blocked next sequence. Recovery refuses a record this version can replay; it records a deterministic refusal for only the selected unsupported or malformed record, replays the readable tail up to the next unsupported record, then publishes an authenticated checkpoint. A later unsupported record cannot undo the selected refusal; it needs its own explicit recovery choice. It never automatically skips a future version. Agent shells cannot use this command.

If another person device has already published a different checkpoint for the same pending recovery, a retry adopts it only when its authenticated sender, supported engine, board identity, covered sequence, and durable refusal receipt for the selected blocker all validate. A concurrent local write prevents adoption; the CLI preserves it and reports that the local export and remote checkpoint need person-led reconciliation. Exporting alone does not clear the saved recovery, and this prototype has no command to merge or discard that conflict.

Recovery stages the replacement before publication and saves the exact sealed checkpoint candidate locally. A known publication failure leaves the native board untouched and keeps that candidate for retry; a lost acknowledgement retries the same ciphertext. Before restoring an acknowledged checkpoint, Pullboard compares semantic native state with the saved digest inside SQLite's write transaction. The local `agent_last_shout_id` inbox read cursor is metadata rather than a semantic write: the check ignores only that field, and recovery preserves the greater valid cursor for each agent present on both boards. Every other native row and field remains guarded; a concurrent semantic write is preserved and recovery refuses with `RELAY_LOCAL_CHANGED`. Ordinary relay sync also refuses while a recovery checkpoint is pending.

Machine relay setup lives outside repositories in `$PULLBOARD_HOME/relay-machine/state.json` (default `~/.pullboard/relay-machine/state.json`), format `v: 2`. The directory is mode 700; state and the SQLite serialization lock are mode 600. State retains the auto-link setting, account and relay origin, stable machine id, excluded project roots, device roster, one pending ten-minute enrollment, pending remote revocations and non-person board-link proposals. Person sessions never persist on the Mac: old machine sessions, Git-directory sessions and retired per-board session files are scrubbed before use. Each linked board keeps a `pm_` credential bound to that board and machine; it can mint `pa_` agent credentials only for that board. `pa_` credentials cannot mint credentials. Explicit `relay on --all` always signs in afresh and preserves the paired phone key. Each roster entry contains `deviceId`, public P-256 JWK, SHA-256 fingerprint, label, creation timestamp, account and relay origin. No device private key is stored on the Mac. The phone retains its non-extractable ECDH P-256 private CryptoKey in IndexedDB database `pullboard-relay-device-v1`, store `keys`, key `device`.

Enrollment HMAC-SHA256 uses an HKDF-SHA256 key derived from the QR-only 32-byte secret, locator-byte salt and UTF-8 JSON info `["pullboard-device-auth",1,account,locator]`. The authenticated enrollment is UTF-8 JSON `["pullboard-device-enroll",1,account,locator,deviceId,{kty,crv,x,y},label,createdAt]`. The Mac consumes its local secret atomically after checking the MAC; relay-supplied public keys are never used as wrapping recipients.

Device wraps are `{v:1,board,device,engine,ephemeral,nonce,ciphertext}`. `ephemeral` is a fresh public P-256 JWK; `nonce` is 12 bytes and `ciphertext` is the 32-byte board key plus its 16-byte AES-GCM tag, both canonical base64url. ECDH yields HKDF-SHA256 input, the raw 65-byte ephemeral public point is salt, and UTF-8 JSON `["pullboard-wrap-v1",board,device]` is info. AES-256-GCM AAD is UTF-8 JSON `["pullboard-device-wrap",1,board,device,engine]`. The relay's private `devices.sqlite` stores only account/device identifiers, opaque wraps, expiring public enrollment transports and durable revocation tombstones. Unlink removes board grants; a device revocation atomically deletes all its grants and blocks stale uploads.

Phone approval contexts contain exactly `id,account,publisher,board,device,action,target,machine,command,expires`. New-board link requests have one visible ten-minute proposal and may retain a private reply JWK because their reply grants only board-scoped machine power. Native revocation reply keys are non-extractable and RAM-only. One phone tap returns a `pg_` grant, limited to two minutes and bound to the entire immutable context; the relay retains only its hash and consumes it atomically before executing the exact action. Agent shells refuse native person actions before network access. `relay off` always removes the local link without a tap, including offline and in agent shells; the remote copy remains until a separate explicit phone deletion approval.

Approval intents and replies use separate ECDH/HKDF-SHA256/AES-256-GCM domains. HKDF salt is UTF-8 JSON of the ephemeral public P-256 JWK; info is UTF-8 JSON `["pullboard-phone-approval-v1",direction,context]`. AES-GCM AAD is UTF-8 JSON `["pullboard-phone-approval",1,direction,context]`. The publishing board key authenticates the sealed intent with HMAC-SHA256 over UTF-8 JSON `["pullboard-phone-intent-v1",envelope]` before the phone displays an approval. Opaque encrypted replies never expose a native grant to durable storage. Journal format 3 permits machine sender attribution, upgrading format-2 CHECK constraints atomically while preserving history, snapshots and sequence heads.

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

<!-- board-indexes:start -->
| Index | Table | Columns | Unique |
| --- | --- | --- | --- |
| `board_meta_agent_session_value_v1` | `board_meta` | `meta_value` | no |
| `board_meta_grant_activation_unsafe_v1` | `board_meta` | `meta_key` | no |
| `board_meta_grant_activation_v2` | `board_meta` | `(expression)` | no |
| `event_by_at` | `event` | `event_by`, `event_at` | no |
| `event_fact_identity_v2` | `event` | `(expression)`, `event_id` | no |
| `event_fact_malformed_v2` | `event` | `event_id` | no |
| `event_fact_unknown_v2` | `event` | `event_id` | no |
| `event_item_id_event_id` | `event` | `item_id`, `event_id` | no |
| `event_kind_id` | `event` | `event_kind`, `event_id` | no |
| `item_lane_status` | `item` | `item_lane`, `item_status` | no |
| `job_kind_item` | `job` | `job_kind`, `job_item` | no |
| `shout_answers` | `shout` | `shout_answers` | no |
| `shout_evidence_item` | `shout` | `shout_evidence_item` | no |
| `shout_from_at` | `shout` | `shout_from`, `shout_at` | no |
| `shout_open_decision` | `shout` | `shout_decision`, `shout_to` | no |
| `shout_open_request` | `shout` | `shout_request` | no |
| `shout_target_id` | `shout` | `shout_to`, `shout_id` | no |
| `test_result_key` | `test_result` | `test_result_input_key`, `test_result_command`, `test_result_context` | no |
| `verdict_item_id_verdict_id` | `verdict` | `item_id`, `verdict_id` | no |
<!-- board-indexes:end -->

`(expression)` denotes an unnamed expression column in SQLite's `index_info`. For `event_fact_identity_v2`, it is `json_extract(event_detail, '$.id')`, followed by `event_id`; the partial index includes fact rows readable by `json_valid(event_detail, 10)`. The malformed index covers invalid TEXT fact rows and the unknown index covers invalid non-TEXT fact rows, both ordered by `event_id`. All three are nonunique additive indexes installed once by the owning writable opener; read opens do not install them. A missing-index append refuses with `FACT_INDEX_NOT_READY` and asks the owning checkout to open the board once.

For `board_meta_grant_activation_v2`, the expression is `CASE WHEN json_valid(meta_value, 10) THEN json_extract(meta_value, '$.sequence') END`. Its partial predicate includes only `relay_receipt_*` keys whose nested move engine is at least `AGENT_GRANT_ENGINE` (currently 127), with both the envelope and nested move guarded for JSON5/JSONB readability. `board_meta_grant_activation_unsafe_v1` indexes the receipt keys whose envelope or nested move is unreadable; the exact guarded expressions are in `src/relay-activation.js`. Owning writable opens install these derived indexes and restamp the board, including already-current boards; read and non-owner opens do not install them. An indexless writer retains the literal legacy query with one `RELAY_ACTIVATION_INDEX_MISSING` notice per process, rather than refusing the write. Unsafe legacy receipts also retain that query and its original errors and short-circuit behavior; this compatibility path remains unbounded. Neither index changes native receipt bytes or the schema or engine version.

`packages/state/src/io/machine.js` declares the lifecycle and retained records. `packages/store/src/io/board.js` installs these persistent triggers in the board file:

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

The `event` table is a SQLite schema object governed by `SCHEMA_VERSION`; its append-only record format has the independent `EVENT_LOG_VERSION`. Each event has an increasing integer id, an ISO timestamp, the actor, the event kind, an optional item id, and a JSON object in `event_detail`. Board moves append their event inside the same immediate transaction as the move. Events are append-only; board triggers reject updates and deletes. The actor column is the acting agent id, except guard-repair events, which use `board`. Under engine 8 and later, each event by a registered agent also carries a `model` string snapshot in `event_detail`; legacy agents without a declaration use `unknown`. Declared models live under `agent_model:<agent id>` in `board_meta`, without changing the agent table or stable ids. Rejoining with another model appends a `model` event whose common snapshot holds the new declaration. This common snapshot is separate from the per-kind payload fields listed below. The following rows name the emitted kinds and the union of their operation-specific detail keys; CLI accept events additionally carry the frozen-check result described below:

The computed-grant engine adds `grantEngine` to new join, claim and renewal events as a version marker only. It stores no grant or scope: permission is computed from the seat lane, current claim and lease, or the current review reservation. Older event bytes remain unchanged. A new marker prevents an older engine from reinterpreting a narrowed claim; shout, release and review reservation keep their existing engine floors. Reopen still checks the marked seat and target version floor, while its own authority guards decide permission: direct current conflict requests are coordinator-only; automatic review preflight records native-computed evidence bound to the board, actor, item, submitted head, trunk and conflicting files, verified at origin and replay by merging the recorded immutable commits, never the replica current trunk; missing objects refuse without advancing the replay cursor until fetched. The exact accepting reviewer can withdraw its current verdict independently of a build claim. Older recorded submitted-conflict moves retain their joined-seat authority.

Automatic milestone placement records its chosen release, order position, rule and prerequisite, spec-row and lane inputs on the item. A coordinator or person override records its reason and actor; an unavailable release remains explicit in the placement note.

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
| `health-scan` | observing agent | `active`, optional `pendingCpu`, `engine` |
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
| `submit-handoff` | queued builder | Queue `state` (queued, running, green, submitted, red or incomplete) and captured source `commit`; submitted retains an accepted submission whose native gate was not green; job identifiers and refusal text stay in private board metadata. |
| `submit_handoff_returned` | queued builder | Captured `commit`; from the queued red return engine, the failed item stays claimed by its builder with a fresh `leaseUntil` (its refusal stays in private board metadata) and opens for anyone only when that lease lapses. Older engines carried the builder's first-refusal window and returned the item open. No other claim is released. |
<!-- events:end -->

A CLI `accept` event includes `check: "none"` when no frozen item check ran or `check: "green"` when it passed. Older accept events and records without this field read as `unknown`; the result stays in event detail and does not change the board schema or event-log version.

An engine-10 `reopen` of a verified item adds `supersedes` with the earlier accept event id and `landingFailure` with `{batch, tests: [{file, name}], mergeCommit}`. For a recorded red batch, `batch` is its id and the tests and merge commit come from that batch. For a hand-run landing, `batch` is `null`; the coordinator's note supplies a test path and name plus merge commit, which are recorded without checking that commit against the repository. The accept event and verdict row remain append-only, and merged items cannot be reopened. Engine-8 and engine-9 `reopen` events keep their original `{commit, note, judgment}` detail and submitted-only behavior.

A `reopen` with `withdrawVerdict: true` records `withdrawnVerdict: {verdictId, acceptEventId}` for the exact current acceptance withdrawn by its accepting reviewer or the coordinator, and `supersedes` names that same accept event. The original verdict row and accept event remain immutable; history derives their withdrawn state from this binding, without rewriting earlier records or reviving an older acceptance. A later fresh acceptance can become current. This flag requires the verdict-withdraw feature engine; ordinary reopen records and older recorded moves keep their original meaning.

Item facts use the existing append-only `event` table and event-log version 1. A `fact` event's actor and timestamp stamp its author and time; its detail carries a stable string `id`, typed `kind`, exact `text`, optional `ref` binding or `null`, and superseded fact id or `null`. Allowed kinds are `capture`, `measurement`, `note`, `diff`, `decision`, `rejection`, `supersession` and `root-cause`. The item-notes engine adds observation kinds `question`, `answer`, `plan` and `risk`; earlier engine receipts retain their original allowed labels. These facts carry the same id, author, timestamp and exact text and never create shout records or signed approval authority. Judgement kinds and any correction using `supersedes` require the item's live holder or the coordinator. A correction must refer to a fact on the same item; it adds a new event and preserves every earlier fact.

A binding is `{path, start, end, commit}`: a relative repository path, a positive ascending inclusive line range and a full 40-character hexadecimal commit id. It identifies code without storing source or requiring Git on a replica. Fact ids are generated UUIDs locally. A sealed `appendFact` operation uses its executable move id as its fact id, so replicas keep corrections bound to the same fact even when local event sequence ids differ. Native export/import retains these event rows without a separate fact table or schema upgrade.

The derived `thread` in CLI `show` JSON and API v1 item state is an array in ascending event order. Move entries are `{type: "move", eventId, kind, by, at, detail}`. Fact entries are `{type: "fact", id, eventId, kind, text, by, at, ref, supersedes}`. `eventId` is the board's numeric event sequence; `id` is the stable fact identity used by corrections. `by` and `at` come from the immutable event author and UTC timestamp. `detail` retains a move's original structured payload. Nullable `ref` and `supersedes` preserve omitted fields as `null`. Superseded facts remain in the array beside their corrections. Engine-18 facts add three optional fields, present only when set: `implies`, `decision` and `supersededBy`.

A decision that names the items it changes writes one `fact` event of kind `note` on each named item; the decision's own `fact`, `accept`, `reject` or `answer` event records the requested ids as `implies`, and an answer event records the answer it supersedes as `supersedes`. The implied fact's `decision` cites the decision as `{source, id, item, by, line}`. `source` is `answer`, `verdict` or `fact`. `id` is the answer's shout id, the verdict id, or the fact id. `item` is the item the verdict or fact belongs to, and `null` for an answer. `by` is who decided, and `line` is the decision's first nonempty line; a verdict's line is `accept CRITERION_MET: <note>` or `reject <REASON>: <note>`. The fact's text reads `implied by <decision> by <who>: <line>`. When the decision is superseded, each item it implied gets a second `note` fact with the same `decision` and a `supersededBy` citation of the new decision; its text reads `<old decision> by <who> is superseded by <new decision> by <who>: <line>`. Each fact's author is the decider who caused it: for an implied fact, the old decision's decider; for a supersession notice, the new one's. The citation is built from the board's own record of the decision (the answer's sender, the verdict's reviewer, the fact's author), never from the move's arguments, so only the person's own answer yields a `by: "person"` citation. Only the person supersedes the person's answer. Implied-fact ids are `<seed>-i<item>` and supersession-notice ids are `<seed>-s<item>`. The seed is the decision's fact id for a fact, and for an answer or verdict it is the sealed move id, or a fresh UUID for a local move. Every replica therefore writes the same ids. `pullboard why <id>` reads these facts and lists the decisions that imply an item, newest first. `pullboard resume` shows each implied fact on an item the agent holds once per checkout, recording the shown fact ids in `.git/pullboard-checkout/decisions-seen.json` (or the worktree's own git directory) as `{version: 1, seen: [<fact id>...]}`.

Engine version 3 adds the sealed `appendFact` operation. It is the single engine increment reserved for the release after 0.7.0; other changes in that release reuse version 3. Older supported operations remain replayable; an older client refuses a version-3 move before applying it. The sealed envelope, CLI/API envelope, schema and event-log layout versions are unchanged.

New CLI claims include a `policy` object (`version: 1`, `commit`, `verify: { policy, family }`) in the frozen criterion. It pins the coordinator checkout’s committed configuration on its attached main branch and captures that commit’s verification and family rules. Relay verification uses those shared frozen values, ignoring policy values supplied by the sealed move; missing or invalid captured values produce `NO_POLICY` with an explicit refreeze step. An ordinary criterion recheck preserves legacy frozen bytes and their digest. An explicit refreeze captures the pinned commit’s verification rules and establishes a new digest. A temporary detached review checkout refuses new policy-dependent claims or project gates with `NO_POLICY`; the coordinator returns to its main branch. Existing frozen submissions remain verifiable. Legacy claims use their recorded claim-base commit. A CLI `submit` records the pre-merge coordinator HEAD as optional `policyCommit`; historical doctor and acceptance checks use this snapshot when allowing unchanged foreign files brought in from MAIN. Verified dependencies may also contribute unchanged files in their own lanes before a MAIN merge; foreign deletion or replacement is not authorized by an unrelated dependency’s tree. The complete candidate diff against both claim base and frozen MAIN is checked with rename detection disabled, preserving deleted paths and whitespace in names. Frozen item checks run against the exact submitted commit in an isolated checkout when accepting and auditing; repairing a reviewer’s checkout cannot make a red submission green.

Person answer events additionally record their `channel`, either `terminal` or `view`, including the forwarded answer to the original asker. Agent answers omit that field.

Person row decisions use one `row_decision` event per row. Its `record` holds `kind` (`spec` or `doctrine`), file, id, exact source and replacement lines, target text, decision, reason and identity. SSH approvals additionally hold the canonical signature and trust anchors. The current index is additive `board_meta` key `row_decisions`; each entry includes its event id, timestamp and applied state. Coordinator `row_apply` events name the exact decision event ids applied locally. Atomic approved-spec corrections also record `refreezes`, containing each affected item id and its before/after frozen digests. The sealed move carries complete frozen bytes and before-state snapshots; an explicit empty array marks a changed row with no unlanded citations. Current corrections refuse an omitted payload; older recorded moves retain their original metadata-only meaning. Replay never writes checkout files.

`SPEC_DRAFT_REFREEZE_ENGINE` adds optional `skippedDrafts`: the exact ordered ids of open items that have never been frozen and cite a draft or pending row explicitly declined by the person. The receiver derives that set from native decisions and freeze history, and refuses missing, extra, reordered or stale omissions. Frozen work and ordinary approved-row citations keep the correction protocol above. The CLI names omitted items in one line; omission does not grant a claim or erase their citations. Marker-free historical corrections retain their original expected item set; older engines refuse the new marker.

An optional per-item required reviewer family is stored at additive `board_meta` key `item_review_family:<id>` and projected as `item_review_family` only when set. Engine-142 add and edit events retain the requested `reviewFamily` spelling. Modern add and edit events instead carry `reviewPolicy`, retaining the spelling within that policy and synchronizing the legacy projection key. Review selection, reservation and verdicts match the declared agent family case-insensitively; an undeclared or different family cannot satisfy it, and model names supply no inferred family. This requirement does not waive independent-parent or repository-wide reviewer policy.

An approval of proposed new wording uses that same record: `source` is the existing exact line and `replacement` carries the approved target text. Pre-commit compares the staged target against the person decision or a verified staged signed receipt. No second approval format or event kind is needed.

Migration preserves event rows and adds only schema objects that are missing.

## Flow report and captured submission size

`stats` JSON exposes `flow.report` with `scope: "all-time"`, including when the older statistics are filtered with `--since` or `--window`. It reconstructs recorded lifecycle intervals rather than inferring old history from current item rows. Its seven disjoint stage keys are `ready`, `later`, `build`, `reviewWait`, `review`, `mergeWait` and `rework`. Initial open time outside the recorded focus milestone, behind an unverified dependency, or under an item/lane hold is `later`; otherwise it is `ready`. A claim starts `build`, submission starts `reviewWait`, a live reservation starts `review`, and acceptance starts `mergeWait`. Reservation expiry/release returns to `reviewWait`. Rejection, reopen, non-retained refreeze, escalation, build release or claim lapse starts `rework` until the next claim. A retained refreeze preserves the active build. Missing lifecycle boundaries remain explicitly unknown rather than becoming measured zeroes.

The report supplies per-item, per-lane, per-milestone and overall aggregates. An item can belong to several recorded milestones: `item.milestones` lists all active memberships, while `item.milestone` retains the latest active membership for compatibility. Membership in any focused milestone qualifies as focused. Each milestone aggregate includes its members once, and the overall aggregate counts the item once regardless of overlapping groups. `firstTry` counts known first-submission accept/reject decisions; later successful attempts cannot turn an initial rejection into first-try acceptance. `submissionsPerLanded` is unknown when its required history is missing. First-submission size buckets are `under100` (0–99), `100to300` (100–299), `300to800` (300–799), `800plus` (800 or more), and `unknown`.

A `submit` may carry `submissionSize: {base, head, lines, method}`. `base` is the exact accepted main commit used for comparison, `head` is the submitted commit (and must equal `commit`), `lines` is a nonnegative safe integer, and `method` is exactly `"added-plus-deleted-no-renames"`. The comparison is `git diff --numstat --no-renames <base> <head>`: added plus deleted lines across all changed files; binary `-` columns contribute zero. This is captured once at submission, not recomputed later against a moving trunk. Missing or invalid historical metadata belongs in the unknown size bucket. This optional move-envelope field is gated by the `FLOW_SIZE_ENGINE` leaf, whose numeric engine assignment is made at landing; older recorded moves retain their original envelope and replay semantics.

## Submit test selection

`pullboard.json` may set `"itemSizeBudget"` to a positive whole number of changed lines; it defaults to 100. A successful submit whose diff against current main adds plus deletes more than twice that budget prints one note with the count and suggests splitting into a chain of smaller items. At or below twice the budget it prints no size note. This advice never blocks submission; the budget is read from accepted main.

`pullboard.json` may set `affectedTests` to a command prefix that runs selected test files. When it is absent, `submit` runs the configured `gate` in full. When present and the import graph can safely select a subset, Pullboard appends the selected file paths to this prefix; an uncertain selection still runs the full gate. For example, this repository opts in with `"affectedTests": "node apps/cli/src/io/run/tests.js"`. Projects using another test framework can leave the setting out and keep their configured gate, such as `npm test`.

`pullboard.json` may set `worktrees` to `"inside"` or `"beside"`. Fresh `pullboard init` writes `"inside"`, placing new agent worktrees under `.claude/worktrees/<lane>-N`; it also adds `.claude/worktrees/` to `.gitignore` and prints guidance for dot-scanner ignore rules. An omitted setting defaults to `"beside"` to preserve existing sibling paths (`../<repo>-<lane>-N`). `pullboard resume --diagnostics`, JSON v1 `pullboard resume --json`, and `pullboard help worktree` show the active location from the primary checkout's config.

A project with `"submitGate": "landing"` can also set `"submitInvariants": ["test/guard.test.js"]` to run a small set of project guard files on every submit, even when uncertain selection defers the full suite. The list defaults to empty and requires the project's explicit `affectedTests` runner; no framework or test files are added by default. Submit reads the list and its runner from accepted main, so a candidate cannot remove or replace its required files. Named affected tests and invariants run once per file, with their paths and results in the receipt. Missing invariant files refuse the submit, and subset passes never stamp the full gate. The coordinator still runs the configured full suite at landing.

With `"submitGate": "landing"`, `"submitDeferAbove": N` (a whole number, 1 or more; absent by default) moves an affected selection of more than N test files from submit to landing. Such a submit runs its frozen check, the static checks and `submitInvariants` only, records the selection as `submissionProof.deferredFiles`, and notes `<count> affected test files deferred to the landing gate` on the submission, where `show` prints it. A full-gate landing already runs every file. A landing with `"landing": { "publish": "separate" }` runs the recorded files on the merged tree before anything lands; a red sends back each item whose own deferred files failed, and nothing in that batch lands.

<!-- pass-rule:start -->
The `pass` event is emitted by `passDecision` only for the coordinator in the historical protocol; another agent receives `COORDINATOR_ONLY`. The lane-lead engine also permits the addressed lead to escalate its own lane question to the coordinator. Its event actor is the coordinator or that lane lead. The coordinator passes to the person; the lead passes to the coordinator, while the event table records who performed the pass.
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

### Landing records

Engine 8 adds `recordLandingBatch`, `recordLandingWaiver`, `recordLandingFlake` and `finishLandingBatch`. Older engines stop before applying these operations. Their append-only events need no schema migration. A batch snapshot has version 1, identity, base and tip commits, trunk branch, landing worktree, items with their first-containing merge commits, state, owner, log path and revision. Additional owner-lease and environment fields can be added without changing version 1. A revision refuses stale updates. Successful push precedes the atomic merged receipts and single `main-moved` event. An engine-12 landing finish ordered after an engine-33 checked re-review still records the tree the older client actually pushed. If that legacy batch did not check the newer reviewed head, it also appends `landing-review-moved` with `code: "LAND_ITEM_MOVED"` and the exact verdict, checked head and landed merge. The newer review reads stale until its checked composition reaches the known trunk; the earlier landing receipt and verdicts remain immutable. Recovery creates a separate correction item rather than reopening or re-reviewing the already-landed original. Historical finishes ordered before the newer review retain their original receipts.

A person waiver records its identity, named test, expiry, reason and person channel. A distinct landing proof records the exact batch tree and each failing test with its covering waiver identity. Pre-push checks every waiver against the current time; this proof never writes an ordinary green-gate stamp. Flake records retain a test path, source digest, failing names and one defect item, so a repeated observation does not create another defect.

Engine 34 adds the agent/coordinator `orderMilestoneItems` move, carrying a milestone name and its ordered subset of item ids. Earlier engines refuse it before changing the board or replay cursor. Ranked item ids stay with their milestone in its `order` metadata; old entries without it keep their prior queue order. Recorded next/reserve moves below engine 34 retain their original ordering even when later metadata contains ranks. The stable minimum is `MILESTONE_RANK_ENGINE` (34); engine slots 25 through 33 belong to their separately allocated train items.

`WORK_ORDER_ENGINE` lets the coordinator's `orderMilestoneItems` carry `place` (`pin`, `sink` or `lift`) and, for a pin or sink, a `reason`. A pin appends its ids to the milestone's `order`, a sink to its `sunk` list, and both record the reason under each id in its `reasons` map; a lift removes the ids from all three. Earlier engines refuse a move with `place`. From this engine on, next and reserve moves order unranked items by the computed queue order (unblock count, effort, readiness), sunk items last; recorded moves below it keep their milestone, rank, route and age order.

Engine 43 (`RIGOR_NOTICE_ENGINE`) posts one coordinator shout and one typed `rigor-notice` receipt when a reject, reopen or person never-again fact makes a cause repeat. Both are part of that move’s transaction. Recorded engines through 42 retain their original event streams. A person’s exact row-decision receipt for a typed Rigor source silences that repeat until a new item repeats it; later commits on an already known item do not override the decline.

A proved Rigor draft carries `source: rigor:<percent-encoded JSON>` with `version: 1`, its `key`, `evidence` (`items`, `occurrences`, `neverAgain`) and `proof` (`check`, `red`, `green`). The proof contains actual full commits, executed exit statuses and problem counts. The existing spec and doctrine row grammar reads this field; prose mentioning Rigor is not a typed source. The person uses ordinary Approve or Decline, and the coordinator applies the approved row without a new build item.

`RIGOR_AUTO_ENGINE` adds implicit evidence-only proposals to reject, reopen, person never-again and attributable conflict-hold moves. An omitted cause derives from a current-head structured reviewer failure, structured landing tests, exact conflict files, or a coarse coded verdict/reopen category; notes never identify tests. File keys use `conflict:<URI-escaped path>` and stay architectural advice rather than code-rule failures. Explicit `--cause` wins. Older recorded engines retain their original causes, notices and event streams.

The triggering transaction reserves ordinary board row-draft entries with `written: false`, `gate: review`, `tier: aim`, and a terminal `Source: rigor-auto:<percent-encoded JSON>` in their text. This distinct source has `version: 1`, `unproved: true`, `key` and exact repeat `evidence` (`items`, `occurrences`, `neverAgain`, event ids); it has no executed red/green proof. One receipt names the created drafts. It changes no repository file and approves no rule. Needs you exposes each pending proposal, including a visible collision if another row occupies its id with different fields. `spec apply` explicitly materializes these proposals after preflighting existing person decisions and all automatic row definitions across both files. The existing exact-file person approval/decline then applies. `rigor --draft-splits` prepares existing automatic split advice instead of creating a second proposal. An exact person replacement remains authoritative on later application; a stale or unrelated row cannot impersonate it.

Pending proposals are deduplicated per cause and target. A decline covers all items seen through the actual decision, and only a new item can re-propose that declined cause. The read-only digest restates each unanswered automatic draft once per briefing after `landing.cadence`, defaulting to one day when no cadence is configured. Creation is automatic on relevant new failure moves; this is not a historical backfill, a proof of causation, or an automatic remedy.

Engine 54 replaces the automatic strong-to-strong ceiling escalation with one coordinator notice per rejection pair, naming the builder and both rejection receipts. Ordinary rejection still reopens and clears the owner and lease. Light and mid routes keep engine-50 automatic escalation. Engines 50 through 53 retain their original ceiling escalation when replayed.

### Native release receipts

A native release gate runs the accepted command afresh on its exact clean accepted head. It requires nonempty compatible work on every registered executor, with at least eight distinct executors. Placement restricts ordinary admission; it grants no browser, GUI, memory or timing capability. CPU-runner work cannot count as local participation. Missing hosts or incomplete collection refuse the release.

The gate's private receipt writer records a version-one `kind: "release"` receipt with full collection and a required `participationDigest` of every canonical participation field. The gate finalizes its observed participation and run interval before writing that digest; the wrapper reuses those exact fields. Ordinary gate, landing and proof receipts cannot carry this release-only field and retain their previous bytes. Its collection `batchId` is this release run's UUID, separate from a board landing batch. After validating that receipt and actual shard participation, the producer writes a version-one `{gateReceipt, participation}` envelope under the common Git directory's `pullboard/release-receipts/`. Participation binds head, tree, accepted command digest, required executor identities, an exact partition of completed files, per-shard source and command digest, cleanup and the run interval. Only this successful execution path leaves the reusable green stamp.

Structural validation or a local file grants no publishing authority. The hosted consumer authenticates the exact main-commit producer workflow run and its unique artifact through GitHub, then independently binds the envelope to the tagged Git tree and committed command. Invalid, red or pending producer evidence fails; only an absent producer permits the existing main-CI fallback. The npm publisher remains hosted with OIDC provenance. Provisioning and the timed eight-node release remain separate from these data-format checks.

## Native proof provenance

`PROOF_RUN_ENGINE` adds `recordProofRun` and the append-only `proof-run` item event; its unassigned leaf receives its permanent number at landing. The gate writes a version-two receipt in the existing gate receipt store after execution. The ordered move reads that file itself and binds its recorded seat to the authenticated actor; caller-written provenance is refused. Replay carries the canonical receipt rather than reading the originating machine's filesystem. Like the existing gate-run protocol, this trusts authenticated ordered replay and trusted recovery inputs; it is not independent cryptographic attestation of a machine owner or an imported history. The existing `gate-receipts.jsonl` timing receipt links its executed phases through `proofReceiptIds`; there is no agent-written provenance log. Version-one gate receipts retain their separate flake and quarantine meaning.

`pullboard show <id> --json` adds `proofReceipts`, in event order. Each entry identifies its native receipt, command kind, item, commit, tree, frozen digest, actual executor environment (`node`, `platform`, `arch`), runner, seat, recorded parent session, exit code, explicit pass/fail/skip counts, duration in milliseconds and source cleanliness. The runner identifies the executor from its native receipt, including the local runner's identity. Unavailable identities or counters stay `null`; a legacy seat's identity is not recorded-parent assurance. New receipts also carry `testRuntimes`: each child reports its own PID and environment before executing, and the ordinary test-file dispatcher binds its selected file to that closed child, yielding `{pid, environment, file}`. `file` is a relative test path or `null` for an arbitrary Node command. Missing capture is `null`; historical receipts without this field retain their canonical bytes. The singular proof `environment` is the common actual child identity, or `null` when the children differ or are unknown. Plain `show` lists each child separately, including mixed versions. Launcher and worker metadata never substitute for a missing child report; this adds no runtime configuration or requirement to execute on multiple versions. Plain `show` prints the same receipt chain. A missing receipt prevents publication of an executed command's outcome. At `PROOF_RUN_ENGINE` and above, shouts longer than 400 Unicode code points are refused with `SHOUT_TOO_LONG`, pointing callers to receipts and `show`; older moves replay under their original limit.

## Approval provenance

A row approved after the board’s compatibility baseline is reported as `agent-approved` until its exact source is backed by a person decision or a verified signed row-decision receipt. The initial approved set is recorded during `init`, before the setup commit. An older board records its existing approved rows on its first ordered command with this version; earlier reads report the baseline as pending and flag nothing. The snapshot is a compatibility boundary, not evidence of historical person approval. Git blame supplies the row's commit and author, labelled “Git author, seat unknown”; it never establishes person approval. `pullboard spec approve <id>` confirms the row and `spec decline <id> --reason "why"` declines it through the existing person channel. File application remains a coordinator step.

`pullboard.json` accepts the existing `"spec": "SPEC.md"` form, or `"spec": {"file": "SPEC.md", "agentApproval": "flag"}`. `flag` is the default and keeps work moving; `allow` suppresses the outstanding approval call; explicit `refuse` prevents a new frozen citation of an unconfirmed row with `AGENT_APPROVAL_REQUIRED`.

Engine 68 retains the existing validated verifier note in new acceptance-event detail. Earlier engines retain their original receipt shape; later person confirmations project current approval state beside that immutable history. No new row status or approval authority is inferred from a Git author or an unsigned receipt.

The engine-68 `recordSpecApprovalBaseline` move carries `{agentId, baseline: {version: 1, file, anchor, rows: [{id, text, source}]}}`. `anchor` is the current commit or `null` before the first commit; exact source rows also cover uncommitted initial requirements. Only the authenticated coordinator may establish the snapshot; a person uses the main checkout’s coordinator path. Lane commands never seed or replace it. The first snapshot is indexed under `board_meta.spec_approval_baseline` with a `spec_approval_baseline` event. Replay writes metadata only, never checkout files. Sender attribution is authenticated normally, older engines refuse the new move, and later bootstrap attempts cannot replace or expand the original snapshot. No local sidecar establishes shared approval authority. The metadata snapshot must agree with its single original coordinator event; a partial restore with either half missing or changed is invalid. A malformed stored marker remains in place with an invalid-baseline diagnostic; it is not treated as an absent migration baseline or reseeded by later commands. Board imports remain trusted recovery operations; agreement of these records is a consistency check, not cryptographic authentication of an imported history.

## Offline flow replay

`pullboard flow replay --json` reads only event ids, kinds, times, item ids and seat ids from the board. The result includes `history: { version: 1, events: [...] }`; each event has only `event_id`, `event_kind`, `event_at`, `item_id` and `event_by`. No title, description, message, path, commit or event-detail JSON is fetched or exported. Save that history object as JSON and pass it with `--history <file>` to replay the same input on another board.

The default policy, `{"order":"recorded"}`, keeps recorded stage starts, durations and seat concurrency, reproducing complete measured cycles. `--policy <file>` accepts an explicit item-id order (a partial list prioritizes those ids) and the board's `settings.reviewsFirst`, `wipPerReviewer`, `landingBatchSize` and `landingCadenceMinutes`, with the same ranges and off values as `settings line`. `barReady` and `takeoverMinutes` are refused by name as “not modelled by replay”, even when off. Internal stage capacities are not public setting names. Explicit controls are scheduling predictions, never live setting writes. Predicted WIP uses the shared unrounded total cap over claimed and submitted items, with distinct reservation/verdict actors inside the trailing 60-minute window ending at each simulated moment; an empty window counts as one reviewer. Only complete measured cycles supply simulated activity; incomplete work remains explicitly unmeasured. Recorded seat concurrency still bounds every stage. Reviews-first prioritizes ready reviews only above the native submitted-backlog threshold, without preemption. Landing batches take at most the requested number of ready items; the next batch waits for prior completion and the requested start-to-start cadence. Off or unspecified controls retain observed capacities without adding a batch/cadence restriction. Every prediction retains recorded arrivals, seats and work intervals; those intervals include observed waiting and are not CPU measurements.

`replay` reports landing order, each first-claim-to-landed time, and stage quartiles in minutes using the existing flow-window convention (fast/slow quarters use the sorted sample at floor(n/4) and floor(3n/4), with the middle pair averaged for an even median). These counterfactual predictions are not timings measured under an alternate live queue. Landing intervals are the recorded accept-to-merged spans, including observed waiting, not an estimate of CPU work. Incomplete, abandoned or missing-boundary cycles appear in `unmeasured`; they never become zero-duration work. Rejected complete attempts retain their actual builder/reviewer seats and durations. No wall clock or random values enter the replay result.

Native `event_id` order is canonical, even when an input array is shuffled. A history whose recorded timestamps decrease in that order is refused explicitly: the bench never reorders lifecycle events by a clock, clamps timestamps, or presents contradictory clock evidence as an exact reproduction.

## Recorded board line settings

`pullboard settings line --json` reads eight board-owned controller inputs. All default to `false` (off), independently of machine `gate.queue` or `pullboard.json`. `pullboard settings line <name> <on|off|number> --reason "why" --window '{"windowMinutes":60,"activeReviewers":2}'` records a coordinator-owned `setLineSetting` move. The window is a nonempty object of named finite nonnegative numbers, with `null` retaining an unknown measurement. A nonempty reason is required.

| Setting | Enabled values | Off |
| --- | --- | --- |
| `order` | `true` (`on`) | `false` |
| `reviewsFirst` | `true` (`on`) | `false` |
| `wipPerReviewer` | 1.5 through 3 | `false` |
| `barReady` | `true` (`on`) | `false` |
| `takeoverMinutes` | whole minutes 15 through 60 | `false` |
| `collisionFreeBatch` | `true` (`on`) | `false` |
| `landingBatchSize` | whole numbers 1 through 8 | `false` |
| `landingCadenceMinutes` | whole minutes 5 through 30 | `false` |
| `route.liveOnly` | `true` (`on`) | `false` |

`order` opts into next ordering: a builder’s own send-back, scarce review eligibility, release, downstream demand, signed-bar readiness, then coordinator rank. The readiness tier stays inert until the signed-readiness predicate is available (#1110); it never guesses a sign-off from prose. The other inputs retain their separate meanings; `reviewsFirst` selects review versus build and does not turn ordering on. Takeover and landing behavior are separate changes. The move carries `{agentId,key,value,reason,window}`; its native `line_setting` event carries `{key,value,reason,window}` with the board's actor and time outside that detail. Latest values live under `board_meta` keys `line_setting:<name>`, and ordered engine replay updates them and appends the same evidence. The unassigned `LINE_SETTINGS_ENGINE` leaf receives its permanent number at landing. Older engine records cannot request this new operation. Range, unknown-key, missing-reason and invalid-window refusals have named codes. The existing settings API reports each input as `scope: "board"`, key `line.<name>`, with off as its default and the board SQLite file as its source; it does not expose reason text or evidence payloads through that inventory.

The critical-path engine, numbered at landing, adds a longest-remaining-path tie-break inside the primary self-ordering policy (#1017). That policy retains release/focus groups, coordinator pins and sinks, route availability, quick-win interleaving and (unblocks + 1) / effort scores. Only equal primary scores use the remaining unit-item dependency path before recent-file and age ties. Verified and withdrawn work contributes no remaining path. Build offers and queue availability preserve the hard file-collision skip (#1114), even when the colliding item is the only otherwise-ready work. Review offers retain their versioned critical-chain preference and all reviewer-authority guards. Opt-in own-send-back priority and historical engine ordering remain in force. This is a unit-duration ordering, not a measured completion-time forecast. This precedence follows coordinator ruling 29931 and the sharpened #1210 criterion.

With `collisionFreeBatch` on, landing selection previews each reviewed commit against the immutable trunk and reads the resulting Git changed paths, including both rename paths. Overlapping later verdicts wait without reopening; disjoint items still join the current batch. Deferred items keep their recorded place ahead of newer acceptances, even after merge-only re-acceptance. This priority applies only while the setting is on and the item remains accepted and unlanded with the identical submitted commit and frozen digest; new source or a new bar loses that old priority. Once the first batch lands, each deferred item receives one item-addressed reviewer notice in the same atomic landed transition. Existing verdict freshness is unchanged: if main touched the deferred review, its reviewer merges the new trunk and records a merge-only re-accept without a builder cycle or reopening. The default off path keeps existing composition. The control has its own replay-engine boundary; it does not infer paths from briefs.

Landing queue grants, first queue entries and releases are shared ordered transitions. New landing-local-heartbeat engine moves leave renewal and repeated-poll events out of history; old engine receipts keep their recorded meaning. `local:landing-lease:<token>` board metadata binds a physical board id, token/generation, process, branch and coordinator lineage to its local deadline. It is excluded from exports, imports and semantic digests and is retained only on the receiving physical board during a same-board relay snapshot restore. A linked foreign holder has no clock-based expiry: release or coordinator takeover fences it; local heartbeat deadlines never authorize another machine to merge.

Engine 93 adds item-addressed shouts. A shout move's optional `item` names an existing item; its event belongs to that item and includes the message text. Its canonical `shout_to` is `item:<id>`, read by the item's current builder and reviewer and the coordinator. Inbox, resume and seat watch use the same audience; an explicit seat or lane destination with `--item` still uses the item's audience. An item decision is answerable by its current participants or coordinator; replies stay in its thread and audience. The coordinator can still pass it to the person through the existing decision flow. A registered seat's shout to `all` is accepted and stored at reserved address `coordinator+person`, read only by coordination audiences. The plus sign cannot occur in valid lane names or their derived seat ids. Coordinator and person broadcasts retain `all` and reach everyone; recorded older-engine `all` rows retain their original global meaning without a retrospective sender filter. Main-checkout watch remains the person's board-wide observer. A joined seat's default watch filters shouts to its own address, lane, items and `all`, while ordinary lifecycle events remain visible.

The decision-origin engine, numbered at landing, records where an answered decision came from. An `answerDecision` move may carry `origin` (`person-relayed`, `agent` or `inherited`) and `rationale`; either makes it a move of this engine, and an older engine refuses it with `RELAY_MOVE` before changing its board or cursor. From this engine every answer event also records `provenance: {statement, rationale, decidedBy, relayedBy, origin}`. The board sets it, not the caller: a real person answer is `person`, an agent that names no origin is `agent`, and `relayedBy` is the answering seat only for `person-relayed`. An agent naming `person` is refused with `BAD_ORIGIN`. An answer recorded before this engine has no provenance and reads as `unknown`, never as the person's. `pullboard why <file>[:<line>]` lists the items, spec rows and answered decisions behind the landed commits that touched that file or line, found by their `Pullboard-Item: #N` trailers.

### Outside intake and sandbox receipts

`pullboard intake <GitHub PR URL> --criterion "behavior" --check "command"`
reads GitHub metadata and fetches the exact server-owned pull ref. It records an
outside author (`outside:github:<login>`), commit, tree, source state and maintainer
reply, and enters `submitted` without claiming that a native builder gated the PR.
No contributor program is checked out or executed on the host. An issue URL records
an open local source item; the GitHub issue closing does not accept the local item.
Repeating intake refreshes source state and replies. A PR head can change only after
normal return to open; re-intake invalidates its earlier sandbox proof and owner
approval. Native agents cannot claim or submit an outside PR as their own build.

Public source facts are in `board_meta` under `outside:<item-id>` and appear as
`outside` on `show` JSON. Ordered `intakeOutside` and `approveOutside` moves retain
`outside-intake`, `outside-refresh` and `outside-owner-approval` events. Approval is
person authority bound to the exact commit, not an agent or parent-session claim.
These facts survive board export and ordered replay. The local container logs are
beside the board in `outside-check-output/<item-id>/<receipt-id>`; an ordered accept
must match the executor's exact local receipt and output digests before transport.

Sandbox verification reads operational provider settings from committed trusted
main, not from the PR's configuration. `sandbox.provider` is `docker`,
`sandbox.executable` is an absolute Docker-compatible CLI path, `sandbox.endpoint`
is an explicit Unix daemon socket, and `sandbox.images.minimum` and
`sandbox.images.current` are immutable `<image>@sha256:<digest>` references selected by trusted main.
Prebuilt Node+Chrome images are supported for browser gates; outside heads cannot
choose runtime images, and actual container Node versions must still match both roles. Images
must already be present; verification uses `--pull never`. The actual container
must report Linux Node 22.13.x and Node 24.x respectively, the two roles in the
committed CI matrix; this is not a claim about the latest global Node release.
Each role executes the trusted full gate and frozen criterion, with the criterion
also required to fail at the recorded base. Protocol stand-ins in unit tests are
not evidence of real containment or actual image execution.

Every container has no network, an empty temporary HOME, a read-only root and
private source export, no added capabilities, and no host credential environment.
The Docker client has a fresh empty configuration and explicitly constructed
environment. The source export contains independent exact-commit Git objects and
files, never an operational checkout, its board database, worktree pointer,
alternates or credential state. It is copied into a temporary writable container
work directory. Exports default beside the native board under `sandbox-exports`;
`sandbox.exportRoot` may name a private absolute directory shared with a VM-backed
Docker daemon. Only a newly created child is exported and cleaned up. Missing
runtime, inaccessible export or cleanup failure refuses; no host-process fallback
is available. Normal physical gate/browser admission still applies.

Owner-sensitive reasons are retained as `outside.sensitivity`, each with `path`,
`rule` and `detail`; `outside.sensitive` is true when any reason matches. Defaults
cover relay, sealing/signing/keys, person-move and hook code, hook configuration,
`bin/`, CI workflows and command-bearing package fields. Trusted main may extend
this with `intake.sensitivePaths`, relative exact files or trailing-slash prefixes;
contributions cannot remove the defaults. Newly added process imports/calls or
shell-runner calls and unreadable changed files also require approval. Renames
retain both old and new touched paths. Ordinary source is not sensitive merely
because it is source. The owner runs `pullboard intake approve <id>` through the
person channel before sensitive work can land. Intake has no autonomous posting
operation; each future result post still needs the person's separate OK.

`FILE_GROWTH_NOTICE_ENGINE` adds atomic notices to an ordered brief edit: newly named
files on a claimed or submitted item are checked against lease-normalized claimed,
submitted and accepted-not-landed work. Each distinct holder receives one system
notice per overlapping item, linked to its item thread; the edit remains allowed.
Unchanged paths, prose, reordered lists and removals do not resend notices. Older
recorded edits retain their silent behavior. The unassigned feature leaf receives
its number at landing; no event-log or envelope format changes.

### Line capacity decisions

With `reviewsFirst` on, ordinary `next` offers an eligible review before a build when outstanding submissions exceed `wipPerReviewer` times the active-reviewer count (or ratio 3 while that numeric control is off). No permanent builder/reviewer seat type or role flag is required. Active reviewers are distinct registered seats with a reservation or verdict inside the flow window; its default is the last hour, and an empty window counts as one reviewer. The window uses the same validated boundaries as `stats --window`; its native duration is the shared `ACTIVE_REVIEWER_WINDOW_MINUTES` constant (60), not the measurement metadata or a new board setting.

With numeric `wipPerReviewer` on, a new claim that would exceed that limit is refused as `LINE_WIP_LIMIT`, naming the oldest eligible pending review when there is one. Live claimed items and outstanding submissions count; expired claims do not. The shared pure `lineWipLimit` function computes the total cap without rounding, using at least one observed reviewer. Renewals remain possible. The native claim carries the configured verifier and family policies so its suggested review never relaxes those guards. With `takeoverMinutes` on, a sent-back item's idle interval can end its original builder's first-refusal window early; a live claim is never stolen, and normal claim appends preserve the old history. Disabled controls retain the previous behavior. New claims under these controls carry a true `lineCapacity` argument and the line-capacity engine floor; marker-absent older recorded claims keep their historical meaning during replay.

### Item decision options

A `shout` ordered move may carry `options`, an array of at least two distinct nonempty strings, only with `decision: true` and an item. The move requires the decision-queue engine leaf; older shouts retain their original meaning. Only the validated top-level `options` argument creates structured choices; legacy opaque `detail` is never reinterpreted. The item event carries `decisionOptions` and `item`; `board_meta` keys `item_decision:<shout-id>` index those options for the open queue. Passing a question to the person copies its original options and item into the new decision index. Answers append ordinary answer events on the item; neither asking nor answering changes the claim or lease.

The explicit top-level `news: true` shout argument emits a native `shout_news` event instead of `shout`, without adding a SQLite column. Its canonical message row remains in `shout`; consumers resolve its recipient and text in the same way as other messages.
Only coordinator or person messages to `all` may be news; combining news with an item,
decision, request or answer refuses as `BAD_NEWS`. Its unassigned activity-news engine leaf is
numbered at landing; news takes the maximum applicable feature engine floor. Old `shout` events
remain ordinary messages regardless of arbitrary metadata matching any news tags. `watch --kinds`
continues to select literal kinds: include `shout,shout_news` to follow both. Older ordinary
shout arguments retain their historical replay conditions. Untyped broadcasts retain their
existing direct delivery, including governing holds and questions.

The inbox's optional JSON v1 `activity` object contains event references, selected entries,
one-line lane/news digests and a continuation cursor. Its private checkout delivery file is
`pullboard-activity.json` in the checkout's Git directory: version 1, board id, agent, current native session
digest, last delivered event id and last session-start news event id. It is local delivery state,
not a native move, parent identity, configuration or authority record. Missing/damaged state
replays activity. Reads freeze an event high-water mark before observing Git; subsequent events
and messages remain pending. News has a separate cursor so an ordinary poll cannot consume a
future session-start digest.

### Local capacity projection

Capacity uses independently versioned `local:proof-stats:v2:capacity-*` shards in `board_meta`. These are rebuildable local indexes, not exported native events or assurance. `capacity-summary` has its own event cursor; an older writer cannot make retained capacity shards appear current merely by advancing ordinary proof counters. Writers catch up only the missing tail. Rebuilds and append updates share the native transaction/savepoint, so a refused move rolls both back.

Per-item shards reuse the canonical flow lifecycle. Per-day/event measurement shards preserve route, recorded submission size when available, attempt cause and missing boundaries. Recorded approval-baseline and person row-decision events supply the approval index. The nightly fit reads seven days of these derived sample shards, not all raw event details. Initial rebuilds fold history without running a forecast per historical event. Snapshots separate five-minute closed-form provenance from fifteen-minute Monte Carlo provenance; missing capability is unavailable, while a measured empty workload is zero. Current item files are used only for current collision advice, never substituted for historical attempt metadata.

The capacity observer capability is version 2; a mismatch clears and replays the local capacity shards through the existing writer migration path. The public snapshot wire version remains 1. `landingOutcome` samples bind the original accepted source commit, acceptance event id, route and recorded size to one completed accepted episode. Acceptance requires the matching submitted state and source commit, so duplicate acceptance receipts do not create new episodes. A merged event completes that episode without requiring its landed merge/squash SHA to equal the accepted source SHA; a typed reopen failure must match the accepted source SHA. Clearing the completed episode deduplicates repeated return or merged receipts. Untyped exits and invalid episode provenance retain unknown outcome coverage instead of silently increasing the observed zero-failure cohort; unfinished accepted episodes remain right-censored. These outcome samples establish risk separately from terminal coordinator batch-cycle timing, not missing failed-cycle durations or abandoned pre-submission occupancy.

The lane-lead engine, numbered at landing, adds coordinator-only `setLaneLead` with `{agentId, lane, seat, lanes}`. The seat is an existing agent in that lane, or `null` to remove the lead. Its `lane-lead` event records `lane` and `seat`. Typed shout routing records `messageKind` (`question`, `blocker` or `decision`); a status shout is refused. Older recorded engines retain their original routing and event details. Questions and blockers go to the named lead; lead decisions and explicit escalations go to the coordinator. Naming a lead grants no claim, lease or person authority.

Companion requests use the `requestCompanion` move and the unassigned `COMPANION_ENGINE` boundary allocated at landing. The authenticated first argument names `agentId`, `parentId`, target `lane` and stable `key`. A `board_meta` key `companion:` plus SHA-256 of JSON `[parentId,lane,key]` binds that identity to its child. The immediate transaction creates the ordinary item, records its check baseline and bar, appends the companion event, and stores the binding. A retry returns the existing child without changing its contents or claim. Ordinary `addItem` parent-lane validation remains unchanged.

### Signed board membership

`setBoardMembers` records an exact next revision in `board_meta.board_members` and a `board_members` event. Its signed document is `{body:{v:1,board,repository,revision,members},by,signature}`; the SSH namespace is `pullboard-board-members` and the bytes are the JSON array `["pullboard-board-members",body,by]`. Repeating the identical document is idempotent. A new empty list removes all additional members. Native ordered transport and checkpoints seal this document with the board key. A key handover independently checks the approving login against committed `pullboard.json` approvers and its SSH signature against GitHub; stored or relay-provided identity flags alone never authorize a handover. Every requester also proves ownership of its own device key. The current native revision is authoritative; an old signature cannot roll back that state.
## Seat addresses

A seat address is `pullboard:<board-id>:<percent-encoded-seat-id>`, where `board-id` is the board’s existing 32-character hexadecimal `board_id` and the seat component is the canonical JavaScript `encodeURIComponent` encoding of its registered agent id. It is independent of machine and checkout path. `whoami` and `agents` expose it; `shout` resolves it only within the current board and records the existing shout event with the exact recipient agent id. It is a destination, never a grant. Existing relay board credentials and authenticated sender attribution remain required on linked boards. No new stored event or file format is introduced.

The activity-delivery engine, numbered at landing, adds recipient-owned `recordActivityDelivery` and `actOnActivity` moves. Interrupt ids bind a native event (`event:<id>`) or an exact claim lease (`claim:<item>:<lease-until>`). A delivery event lists only interrupts actually included in that recipient's response; an acted event records a separate explicit acknowledgement. An inbox cursor or reading a response never means acted-on. Both moves use the joined recipient as their authenticated actor, preserve earlier event history, and refuse on an older replay engine before changing its prefix. Delivery state in indexed `board_meta` keys is part of the native board and its exports, not a checkout-only cursor. `through` is the safely covered interrupt prefix, `observedThrough` is the read snapshot's high-water mark, and optional `digestThrough` is the separately delivered digest prefix; an elided interrupt must remain available after a later small interrupt is delivered.

The machine resource database adds `waiter.runner_only` and `holder.runner_execution`, both integer booleans defaulting to zero. A runner-only gate ticket cannot consume local or short capacity while a runner is registered. The trusted SSH worker sets `runner_execution` on its own actual private gate holder; inherited admission reads that holder rather than accepting an environment-only claim of remote execution. These are local, additive scheduling metadata, not board move or relay formats.
The CPU-sentinel engine, numbered at landing, names an agent-worktree process after more than twenty CPU minutes, once per host, PID and start time. Current `health-scan` receipts carry `pendingCpu`, the findings whose coordinator notice was held by the existing ten-notice cap. Later scans drain that durable queue without inventing another health-failure episode. An older engine refuses while this queue is pending, preserving its history; older receipts retain their original fields. Observation never signals a process.

## Machine-local relay canary

The canary setting is part of the machine's `settings.json`, not project `pullboard.json` or the native board. Its optional `relay.canary` object is `{enabled, root, agentId, deadlineMs}`. `root` is an absolute checkout path, `agentId` is an ordinary registered non-coordinator seat, and `deadlineMs` defaults to 5000 and may be 100 through 25000. `pullboard relay canary off` sets an existing object to `enabled: false` (or leaves an absent setting unset); it creates no board event or relay credential.

The client-local file `<git common dir>/pullboard/relay-health.sqlite` is separate from `board.sqlite` and from the relay's journal. It contains:

| Table | Rows | Meaning |
| --- | --- | --- |
| `relay_health` | One row with `id = 1` and a JSON `value` | Version-one local history: monitoring start; bounded timestamped probe samples (`ok`, failed step, safe code, elapsed milliseconds and relay version); failure count; degraded/alert timestamps; p95; and durable pending alert or recovery notices. A separate `client` record holds the latest ordinary request sample and its degraded timestamp; ordinary requests never populate monitor samples or clear its active episode. |
| `canary_schedule` | One row with `id = 1` and numeric `next_due` | The next eligible minute, claimed atomically so multiple local views of the same repository do not start duplicate probes. |

The containing directory is created with mode 0700 and the SQLite file is created with mode 0600. A status read does not create it or contact the relay. Pending notices are removed only after the ordinary native notification path completes; a failed or interrupted notification leaves the notice available for retry. These records are machine-local display and scheduling state. They add no board table, event, engine field, relay journal record or sealed presentation field.

### Gone-seat claim maintenance

`claims.releaseGone` in `pullboard.json` defaults to `false`. When enabled, the coordinator's existing `sentinel run` maintenance (also scheduled by the running View every ten minutes) releases a still-live build claim whose known heartbeat is at least thirty minutes old. Missing heartbeat observations do not authorize release. A disabled health scan does not disable this separately opted-in maintenance. No new daemon or heartbeat threshold is introduced.

The ordinary `release` move carries `[itemId, "coordinator", "", {seat, lastSeen}]`. Its single release event records `goneSeat` and a reason naming the seat and canonical last-seen time. The gone-claim feature engine is assigned at landing; older readers must refuse this new authority before applying it. Replay validates the frozen evidence against the claim holder and recorded move time, without consulting a replica's private presence cache or configuration. Reviews, item/lane holds, and subsequent claim/verification guards are unchanged. With the setting off, ordinary lease and release behavior is unchanged.

A successful native `land` schedules an independent full-suite audit after releasing its checkout lease. The first pre-land activation stores the board identity and native event boundary in private `main-audits/activation.json`; older batches do not become a retroactive queue. Each later landed batch remains an obligation until its exact tip is actually on main and its audit completes. A single owner drains finite snapshots, with durable wake generations preventing a landing during an active audit from being lost. Each run uses its own detached worktree at the recorded tip, normal gate admission, and the accepted gate policy at that tip. The worker removes its worktree after verified process cleanup.

The native landing runner has an explicit collect-all mode. Test failures remain red while all planned files finish; caller cancellation, source drift and unverified process cleanup still stop assurance. One invocation UUID binds the runner's exact planned and completed file sets to its completion report. That UUID and the collection mode are removed from test-child environments, so nested fixtures retain ordinary execution. A sharded suite completes only after every shard supplies its own matching completion report.

A byte-bound version-one `land` gate receipt may carry `collection`: version, mode `all`, batch ID, full-scope flag, explicit selected files, completion flag, planned/completed file counts and SHA-256 digests of the sorted file sets. This field requires the main-audit engine when recorded or replayed. The gate's private writer derives it from the actual runner report. Recording it requires the coordinator and an existing landed batch with the same tip, plus the recorded tree when present. Complete coverage can be red; missing or partial coverage never becomes a green audit. Consumers order audits by native `gate-run` events, not executor clocks or private job files.

Every named failing file is routed through ordinary `landing-test-defect` events, retaining its exact blob, batch and failing names and linking its repair item. Gate receipts are saved before routing, so interrupted routing can resume without rerunning the suite. An unknown controller or unverified cleanup remains incomplete, with a durable measurement fact on a landed item; it is never silently retried or called complete. Private audit journals are scheduling and recovery state, not evidence accepted by a push gate.

### Value placement and scheduled audit

The main audit publishes an immutable `test-value-index` generation in the common Git directory. `current.json` points to individually hashed test rows and a complete `report.json`. Change gates read only reached rows. `pullboard test-value` shows the recorded tier and observation source. Missing inventory retains the prior gate; missing rows in a published inventory are audit-only. Changed test-side inputs demote their reached rows to audit until the next inventory. Explicit item checks and configured mandatory invariants still run. Opaque gates retain their configured behavior. No test is deleted.

Native file dispatch gives each test a 600,000 ms default runtime limit. A committed `.pullboard/test-file-budgets/<sha256-of-repo-relative-path>.json` row may tighten it: `{"version":1,"file":"test/example.test.js","ms":30000}`. Set `"placement":"audit"` in that row to move the file to audit selection and exempt it from this gate limit. The gate compares changed rows with accepted main; increasing or removing a tighter limit is refused. Only the actual file run is timed, after resource admission. Direct `node --test`, watch and coverage modes do not use this dispatch check.

Post-land nudges use `main-audits/schedule.json`. The interval in hours is `sqrt(2 * runCost / (lambda * delayCost))`: actual native audit seconds times `testEconomics.costOfWaiting`, actual audit-created main-red repair items per observed hour (at most fourteen days), and `costOfEscape` per hour of delayed discovery. With no measured schedule, zero observed escapes or zero delay cost there is no invented finite interval; an explicit release/manual audit bootstraps observations and remains necessary until a finite cadence is measured. A durable timer wakes the normal admitted worker when a measured finite interval is due. New landings after that time also wake it. Restarting the machine requires a later landing/manual wake to re-establish a stopped timer.

`node <installed-pullboard>/bin/main-audit.js <absolute-main-root> <UUID>` runs pending main audit work explicitly. Append `--release` for fresh full-suite release audit work or `--scheduled` to obey the measured cadence. The source must be installed tooling or accepted main and the repository must have the normal post-land activation. The release's existing configured gate remains required.

Only a complete green native audit can seed incremental action keys. Unknown reach always runs; unchanged keys can reuse the previous complete green audit. Ordinary submit/landing caches are disabled inside audit execution. Changed tests use the existing admitted landing shard scheduler and SSH fleet. A selected native receipt stays selected, never a full gate stamp. An all-reused audit records its origin and key plan without inventing a new native receipt. Coverage comes from Node `test:coverage` events and is packaged by the deepest tracked package manifest. Incremental coverage describes only newly observed modules; unloaded or incompatible layouts remain unknown, never an extrapolated complete percentage. Audit failure repairs are ordinary coordinator moves titled main-red and include every native landing since the last complete green event cursor; their provenance survives ordered replay.
The unassigned `REVIEW_INDEPENDENCE_ENGINE` leaf introduces two-tier review independence. Native `board_meta` key `review_independence:<itemId>` stores `{version: 1, sensitive: boolean, reviewFamily: string|null}` in the same transaction as an explicit add/edit policy. Its absence means Standard unless the legacy `item_review_family:<id>` key declares a required family, which selects Strict under modern review. Add/edit events carry optional `reviewPolicy`; snapshots and re-home records retain Strict policy. Rich policy arguments require this engine, and older sealed replay preserves its original review semantics. Invalid policy refuses rather than silently downgrading to Standard. The first newly recorded native move at this engine atomically saves `review_independence:active`, including a recorded refusal but excluding aborted transactions and existing-receipt replay. Subsequent direct and queued reviews require this engine even for legacy family-only items; genuine older receipts retain their original bytes and meaning. Standard authorship comes from submit-backed exact commits; Strict also reads native item-write history, excluding review protocol writes. Family declarations are explicit agent data, and the submitted builder family remains its immutable submission snapshot.
Typed coordinator requests are native `typed-request` events, with the event ID as the request ID and `item_id` as the exact target. Their `request` payload has version 1, a closed verb (`reopen`, `hold`, `withdraw`, `reroute`), a fixed study cause key, an optional model-tier `route` for reroute, and a bounded note. The seven cause keys are `routing-assignment`, `bar-ambiguity`, `proof-red-tests`, `design-choice`, `conflicting-rulings`, `person-authority`, and `tool-defect`. Creating a request never changes its target or confers person or coordinator authority. These events are separate from person-sealed requests and decision shouts.

The coordinator answers a batch through `answerTypedRequests`; the whole batch validates before any answer is recorded. A `typed-request-answer` event names its request ID, original requester, outcome and note. `declined` requires a reason. `done` also names an exact subsequent native coordinator event on the same item, matching both the requested move and its current outcome. The original coordinator move runs through its own command and guards. Exact answer retries return the recorded result; conflicting retries refuse. Requests and answers appear directly in the coordinator and requester activity respectively. `pullboard request list --all` retains the immutable history. The new operations require the typed-requests engine on native execution and replay.

Coordinator companion patches are native item inputs: `patch attach <item> <file> --key <key> --author <seat>` records exact UTF8 diff bytes, the submitted source, ordered SHA256 digests, and the registered author/session. `patch list <item>` reads that replicated set; `patch remove <item> <key>` stops its application while retaining authorship. Keys are immutable and exact retries do not reactivate removed keys. Attachment is restricted to unmerged native submissions and the coordinator; outside PRs retain their existing proof boundary.

An attachment change returns an accepted item to submitted without changing its frozen criterion. Review checks the exact isolated patched composition and seals its head; landing merges that same head. A changed set refuses an in-flight acceptance. Source-author lane checks include actual patch paths, and all recorded patch authors remain excluded from self/session review even after removal. Unsupported or conflicting patch paths refuse instead of changing a live checkout.

A routed complete native audit failure earns a value-rule catch before its repair is green. The catch retains the exact recorded gate receipt, audit batch, committed test blob, failing name and repair item; it never invents a green repair. In-process CLI calls and source-path references alone are contracts, while actual CLI child launches and undeclared reach remain journeys. Placement refresh can therefore promote a valuable catching contract back to submit or landing.

A known-reach contract starts at reach-selected landing while its value observations are unknown; the report retains null rates and runtime rather than inventing measurements. Measured value then determines submit, landing or audit placement. Product-area count alone never makes a journey. Only actual CLI child boundaries and undeclared reach force the audit tier.
`line_setting:requireReviewFamilies` is a native boolean policy input, absent/off by default. The review-independence engine is required to record or replay this setting. When on, fresh reviews refuse an unknown builder or reviewer vendor family; when off, Standard review retains its prior unknown-family behavior. Standard review keeps the configured `verify.family` off/prefer/require semantics. At the review-routing engine, Strict additionally requires different declared vendor families even when the setting is off, and an explicit required family remains enforced independently. Setting changes retain the ordinary coordinator, reason and numeric-window guards; they never change machine admission settings.

### Unattended rejected work

The `REJECTED_WORK_RETURN_ENGINE` leaf fences `recordHealthFindings` with `returnRejected: true`. Only the coordinator may set this option. A scan binds its event revision and the exact latest open, unheld reject episode; a changed episode refuses `HEALTH_SCAN_STALE`. Ten-minute eligibility is computed from the recorded reject instant. Earlier returns carry the coordinator's sender-checked inactive-seat observation; no receiver consults local presence to replay it. Older engines refuse the option rather than ignoring its effects.

A `reject_returned` event records `rejection` (the exact reject event ID), `builder`, `commit`, the original reviewer `note`, `reason` (`timeout` or `inactive`) and `engine`. An `inactive` receipt also retains `presence`, `heartbeatAt` (nullable) and `observedAt`. This receipt releases only the named reject episode's original-builder reservation, without changing lifecycle state or bypassing any other claim guard. Replayed and repeated receipts preserve that single return; later reject episodes retain their own reservation.

`SOURCE_ADVANCE_ENGINE` adds autonomous main-merge completion. The submitted `item_commit`, original verdict row, bar and native patch source bindings stay immutable. A coordinator worker records `source_advanced` only after ordinary admission executes both the frozen check and the raw affected selection (a full fallback really runs in full; submit deferral and placement tiering do not count). The event retains exact old/input/new heads, tree, trunk, native submission episode, patch-set digest, verdict id, selected-command digest and the gate's own source-clean phase receipts. `item_source_advance:<id>` is the bounded effective-head projection (at most 32 advances per retained verdict); `item_effective_head` and the accepted review's projected head identify the checked composition for review and landing without applying companions twice. A changed bar, patch set, submission episode, withdrawn verdict or missing receipt invalidates the continuation. Old verdict/proof rows never acquire new-head results.

Only a finite trusted-main worker wakes after a landing/merged command or health run; there is no new coordinator command or publication. Its detached exact-source worktree and gate use ordinary custody and cleanup. Clean merges and the declared generated `apps/cli/src/logic/help/additions.js` conflict may advance; source conflicts and genuine named red runs use the existing reopen transition with sealed `sourceAdvanceReturn` CAS context. Unknown infrastructure stays incomplete and records a measurement rather than endorsing or returning later work. The native item thread retains the source-advance event and its proof references. A first recorded effective-head projection raises fresh ordered writers to this feature's engine; already-recorded receipt retries still replay before that floor. The board never rewrites old engine histories.

The review-routing engine, numbered at landing, orders eligible reviews by current-main repair evidence and then current submission age. `reserveNextReview` carries captured local repair item IDs in `priority`; the ordered relay replays those IDs without inspecting a replica's filesystem, and offline item renumbering remaps them alongside `skipIds`. Presence of `priority`, including an empty array, requires this engine; historical envelopes without it keep their recorded engine's selection rules. Ordinary `next` also offers an eligible normal submission waiting more than ten minutes for its first reservation below the review ratio. Facts do not reset submission age, and another submit starts a new interval. Strict reviews retain different-session eligibility and additionally require different declared vendor families regardless of the ordinary family setting.

A newly recorded move at the review-routing engine stores `review_routing:active` atomically, including a recorded refusal. After activation, fresh direct reservations, queued reservations and verdict envelopes require this engine so an older engine cannot bypass Strict vendor independence. Already recorded historical receipts retain their exact bytes and outcomes; aborted transactions do not activate the policy.

Coordinator-authored check timing is stored at additive `board_meta` key `item_check_timing:<id>`. Add and edit events carry an optional boolean `checkTiming`. A true declaration freezes `checkTiming: true` with the criterion; absence retains historical bytes and ordinary admission. Submit, verify, explicit check execution and same-bar source advancement consume the frozen declaration and record actual exclusive timing admission in their gate receipts. A timing-only edit is a bar correction, requiring the same reason and refreeze rules as the command. Older moves cannot edit, freeze or execute a timing-sensitive bar; an already recorded older receipt still replays unchanged. Re-home preserves the source declaration and frozen bar.

`QUARANTINE_CORE_ENGINE` adds optional structured `testOutcomes` to native gate receipts and seals them through `recordGateRun`. Each row carries the committed relative file, exact test name, actual `passed` boolean and `skipped` boolean; missing or incomplete evidence remains unknown. The normal controller observes native events before reporters, excludes cancelled work and duplicate identities, and binds complete result frames to its private run timing id. Test workers do not inherit that id. Source inventories and the private canonical receipt bind the recorded rows; replay uses those sealed facts without consulting receiver files.

At this floor, two executed opposite verdicts for one file/name on the same tree create one `test-quarantine` event naming both runs and one owner-lane repair item. Direct-suite and partial main-comparison observations do not prove a quarantine. Subsequent recorded executions of the exact file/name advance the clean streak; skips and unrelated passes add nothing, a failure resets it, and the first 20 consecutive passes or verification of the repair item releases it. Legacy events keep their prior lifecycle. The existing accepted-main quarantine opt-in controls reporting. New quarantines still execute and report and retain the actual raw exit code, failed counts and blocking verdict. They grant no landing waiver or proof promotion; nonblocking authority is a separate successor.

`SHADOW_TIER1_ENGINE` adds an optional `shadow` fact to native version-two gate receipts, recorded by `recordProofRun` and `recordGateRun` beside the real verdict. It holds `version`, `tier` (1), `verdict`, `real`, `differs` and `reasons`: the verdict tier 1 alone (V4: static checks on the changed files, the item's check, and the tests its change can reach, plus cells only for cell-structure changes) would give. A red run naming no failing test is a static or check failure and stays red; a failing test counts only when the change reaches it, and an unknown reach counts every failing test. The fact is report-only: the receipt's `green`, `exitCode` and `failures` are as run, and nothing reads `shadow` to decide a verdict. An older engine replays the move without it.

`LEDGER_QUARANTINE_ENGINE` makes the typed flake ledger quarantine what it proves. From this engine a `recordFlakeObservation` move files, for every active ledger flake without an active quarantine (rows recorded before this engine included), the ledger's open repair item or a new one with a `flake-repair` event, and one `test-quarantine` event with `ledger: true` naming the flake observation ids as `runs`. A row whose quarantine was lifted after its last sighting stays released until a newer sighting. The landing ratchet counts a ledger-backed quarantine as justified by its own red-and-green proof, however old; a withdrawn or verified repair lifts it. An older engine replays the move without filing.
A release names a reason code from `INELIGIBLE`, `ROUTED_ELSEWHERE`, `BLOCKED`, `BUDGET` or `OTHER` (with its text in the note); the code is the `reasonCode` of the `release` event. Coded releases need the release-reasons engine; genuinely earlier recorded releases retain their meaning.




Native usage input splits add `freshInputTokens`, `cacheReadInputTokens` and `cacheWriteInputTokens` to numeric model summaries. Payloads carrying these fields require the input-split engine leaf; legacy usage payloads retain their original engine floor and stored bytes. Missing provider fields and legacy split values read as `null` (unknown), while provider-reported zero remains zero. Codex cumulative input includes cached reads, so fresh input is its nonnegative difference from `cached_input_tokens`; no cache-write counter is invented. Claude `input_tokens` is fresh input and its cache-read and cache-creation counters remain separate. Existing aggregate input/output fields keep their historical meaning. Item, model and stats reads expose the split without exposing private provider sessions. Shared-session item allocations remain unknown; the undivided shared-session totals retain their own numeric splits.

Item summaries and item details carry `withdrawnReason` and `withdrawnFrom` on every local, relay and hosted projection. Both are `null` unless the item is withdrawn. The reason is the stored withdrawal reason; the prior stage is derived from the complete recorded lifecycle through the withdrawal move (`open`, `claimed` or `submitted`), not guessed from the current row or a capped activity feed. It is the public effective stage: a claim whose recorded lease deadline is at or before the recorded withdrawal time has already returned to `open`. Only the bounded claim deadline is projected for this derivation; private event detail is not exposed. Missing lifecycle evidence leaves `withdrawnFrom` null, and an older sanitized presentation with no authoritative reason retains an explicit null reason.

The main-red failure-lines engine retains the first safe error line for each authenticated main-red failure. Automatically filed repairs store these lines beside the item, and show prints them; older moves replay without those new records. Check baselines retain their named red diagnostics in the recorded observation.

The pinned-claim lapse engine releases a claim on a coordinator-pinned item after 30 minutes without a commit, submit or check, where other claims are released after 40. Older moves replay with the 40-minute rule.

The verified-item hold engine lets `pullboard hold <id>` hold a verified item that has not landed. The hold keeps its accept and keeps it out of landing batches until `pullboard hold <id> --off`; older moves replay with holds on open or claimed items only.

The release-quality hold engine counts a holder’s BLOCKED, BUDGET, or INELIGIBLE release toward an automatic released-twice hold. Maintenance, routing, and OTHER releases do not count; OTHER is free-form and cannot prove quality provenance. Older engine moves keep their original replay behavior.
