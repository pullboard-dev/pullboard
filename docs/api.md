# CLI JSON API

Add `--json` to a Pullboard command to receive one JSON document on stdout. The document has `version: 1`; diagnostics stay out of stderr except for sign-in instructions and check consent notices that must appear before execution. The flag may appear with command options before `--`. A flag after `--` is an argument to the command, not an output-mode switch.

The API version is independent of the package version. Its contract is stable within each major API version: existing command names, required fields, field types, and refusal fields do not change within that version. An incompatible change requires a new `version`. New fields may be added, so clients should ignore fields they do not use.

Decision shouts without a recipient go to the agent's coordinator, or to `person` when sent by the coordinator. An agent may answer a decision sent to its own lane; the reply names that agent and goes to the original asker. An agent in another lane gets `NOT_YOUR_DECISION`. `pullboard pass <shout-id> <note>` is for coordinators: it forwards an open coordinator decision to the person with the original question and note. From the main checkout, `pullboard decisions` and `pullboard answer <shout-id> <text>` default to the coordinator; use `--as person` to select the person's queue or answer a person-addressed decision. Person mode is accepted only in the main checkout. An answer in person mode cannot answer a coordinator-addressed decision, and a coordinator-default answer cannot impersonate the person; the refusal prints the command to retry. A person answer is delivered to the original asker. An agent worktree cannot select person mode.

A successful command returns the fields listed below. `version` is always the number `1`. The catalog lists required top-level fields; nested objects and arrays are command data, and optional top-level fields may be added.

`pullboard settings` reads machine-wide settings from `~/.pullboard/settings.json`; `pullboard settings gateSlots <n>` changes the gate queue capacity, which defaults to `2`. Capacity changes are refused while a gate is running or waiting, so existing holders and FIFO order remain intact.

When `add` or `edit` supplies a new nonempty check, Pullboard measures it once in a temporary checkout of the current `main` commit. The item returned by `add`, `edit`, `show`, and `next --verify` may include `item_check_baseline`: `{command, main, result, seconds?, reason?, warning?}`. `main` is the commit id or `null`, and `result` is `green`, `red`, or `unavailable`. A green result carries `warning: "CRITERION_PROVES_NOTHING"`; text output names that warning when filing, showing, or reserving the item for review. An exact match with the project gate configured at that main commit records green with `reason: "repo gate"` without running it again. A missing main records unavailable with `reason: "no main"` and still files the item. Changing the check replaces this observation; clearing it removes the observation. The captured observation travels with the board move, so replicas store the result without executing the command.

`merged <id> <commit>` records only a commit reachable from the primary checkout's branch that contains the item's submitted commit or has the same stable patch id as the item's change from its claim base. Other commits are refused with `NOT_MERGED`; `--note "why"` records an exceptional receipt and keeps the note in that item's `merged` event.

<!-- api-command-shapes:start -->
| Command | Required top-level fields |
| --- | --- |
| `help` | `version:number`, `help:string` |
| `version` | `version:number`, `release:string` |
| `init` | `version:number`, `root:string`, `notes:array` |
| `hooks` | `version:number`, `notes:array` |
| `join` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string` |
| `worktree` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string`, `branch:string`, `prompt:string` |
| `resume` | `version:number`, `me:object`, `all:array`, `requests:array`, `holding:array`, `sentBack:array`, `awaiting:array`, `toVerify:array`, `toMerge:array`, `open:array`, `stale:array`, `holds:array`, `unread:number`, `newest:array`, `root:string`, `dirty:number`, `next:string` |
| `whoami` | `version:number`, `id:string`, `lane:string`, `path:string` |
| `lanes` | `version:number`, `lanes:object`, `shared:array`, `coordinator:string` |
| `resources` | `version:number`, `resources:array` |
| `settings` | `version:number`, `settings:object` |
| `relay` | `version:number`, `linked:boolean`, `board:string`, `url:string`, `link:string`, `sequence:number`, `behind:number` |
| `list` | `version:number`, `items:array` |
| `roadmap` | `version:number`, `milestones:array` |
| `milestone add` | `version:number`, `milestone:object` |
| `milestone items` | `version:number`, `milestone:object` |
| `milestone move` | `version:number`, `milestone:object` |
| `milestone edit` | `version:number`, `milestone:object` |
| `milestone remove` | `version:number`, `milestone:object` |
| `show` | `version:number`, `item_id:number`, `item_title:string`, `item_lane:string`, `item_status:string`, `verdicts:array` |
| `status` | `version:number`, `me:object`, `mine:array`, `stats:object`, `reviewQueue:object`, `unread:number` |
| `doctor` | `version:number`, `problems:array` |
| `inbox` | `version:number`, `shouts:array` |
| `decisions` | `version:number`, `decisions:array` |
| `ledger` | `version:number`, `items:array`, `stats:object` |
| `log` | `version:number`, `events:array` |
| `add` | `version:number`, `item:object` |
| `edit` | `version:number`, `item:object` |
| `escalate` | `version:number`, `id:number`, `from:string`, `to:string` |
| `run` | `version:number`, `messages:array` |
| `sweep` | `version:number`, `messages:array` |
| `next` | `version:number`, `item:object`, `review:boolean`, `held:boolean`, `shared:array` |
| `check` | `version:number`, `id:number`, `green:boolean`, `seconds:number`, `check:string`, `report:string` |
| `claim` | `version:number`, `id:number`, `renewed:boolean`, `leaseUntil:string`, `digest:string` |
| `hold` | `version:number`, `lane:string`, `held:boolean` |
| `release` | `version:number`, `id:number` |
| `submit` | `version:number`, `id:number`, `commit:string`, `pin:string`, `gate:object` |
| `done` | `version:number`, `id:number`, `commit:string`, `pin:string`, `gate:object` |
| `verify` | `version:number`, `id:number`, `decision:string`, `reason:string` |
| `merged` | `version:number`, `id:number`, `commit:string` |
| `withdraw` | `version:number`, `id:number`, `reason:string` |
| `refreeze` | `version:number`, `id:number`, `after:string` |
| `shout` | `version:number`, `id:number`, `decision:boolean` |
| `answer` | `version:number`, `id:number`, `answers:number` |
| `pass` | `version:number`, `id:number`, `answers:number` |
| `tour` | `version:number`, `messages:array` |
| `lifecycle` | `version:number`, `markdown:string` |
| `view` | `version:number`, `url:string`, `port:number` |
| `view export` | `version:number`, `path:string` |
| `serve` | `version:number`, `url:string`, `port:number` |
| `forget` | `version:number`, `root:string` |
| `prompt` | `version:number`, `role:string`, `text:string` |
| `gate` | `version:number`, `green:boolean`, `report:string` |
| `export` | `version:number`, `tables:object` |
| `import` | `version:number`, `tables:array` |
| `spec` | `version:number`, `rows:array` |
| `spec check` | `version:number`, `rows:array` |
| `spec view` | `version:number`, `path:string` |
| `spec show` | `version:number`, `row:object`, `standing:object` |
| `spec unmet` | `version:number`, `rows:array` |
| `spec signoff` | `version:number`, `count:number`, `by:string`, `ids:array`, `evidence:array` |
| `spec signers` | `version:number`, `added:boolean`, `by:string`, `path:string`, `initial:boolean` |
| `spec approve` | `version:number`, `decisions:array` |
| `spec decline` | `version:number`, `decisions:array` |
| `spec apply` | `version:number`, `applied:array`, `files:array` |
| `hook pre-commit` | `version:number`, `messages:array` |
| `hook commit-msg` | `version:number`, `messages:array` |
| `hook pre-push` | `version:number`, `messages:array` |
<!-- api-command-shapes:end -->

`join` and `worktree` accept an optional free-text `--family` declaration. Rejoining the same worktree preserves its agent id; a supplied family updates the declaration, while omitting `--family` preserves it. `resume` includes it as `me.family`; `show` includes `item_builder_family` and each verdict's `verdict_verifier_family`. These recorded fields are `null` when the agent did not declare a family, and later declarations do not rewrite prior submissions or verdicts.

`status.reviewQueue` contains `pending`, `reviewing` (distinct agents with live review leases), `reserved`, `oldestSubmittedAt` and `ageMs`. Age starts at each outstanding item's latest submit event; reserving or renewing its review does not reset it. An empty queue has `oldestSubmittedAt: null` and `ageMs: 0`.

When outstanding reviews reach `verify.reviewRatio` times the active reviewers (default 3, with zero reviewers counting as one), `next` first offers a review the agent may take. This creates no claim or reservation. Its additive v1 `offer` has the review's `item` id, exact `command` to reserve it, `queue` and `ratio`; `build` previews the otherwise available build or is `null`. `next --verify <id>` reserves explicitly. `next --build` claims explicitly; a fresh claim's event detail records `reviewSkipped` with the offered id (or `null`), ratio and queue snapshot. Renewing an existing claim creates no new skip.

For HTTP `next`, a review offer returns success with `event: null`, `offer` and the ordinary CLI `result`. Send `args.build: true` to claim as before and receive the actual claim event. The unattended `run` command always supplies explicit build intent, records it on fresh claims, and prints the review backlog each iteration.

## Refusals

A refusal keeps the command's existing exit status and prints exactly one versioned document to stdout. In JSON mode stderr stays empty except for sign-in instructions and check consent notices. The command-specific `code` identifies the rule; `message` explains what happened; `next` gives the next step.

Only the coordinator sets or edits an item's `--check`. `pullboard check [id]` prints the command and its setter before execution, and asks for consent when the caller did not set it. Use `--yes` to confirm that command without a prompt. An EOF or declined answer refuses with `CHECK_CONFIRM` before running the command. With `--json`, the notice and prompt appear immediately on stderr and stdout remains one JSON document; a successful check result also includes the optional `by` setter field.

```json
{
  "version": 1,
  "error": {
    "code": "NODE_TOO_OLD",
    "message": "this is Node 20.11.1, and pullboard needs Node 22.13 or newer",
    "next": "install Node 22.13 or newer, then run the command again"
  }
}
```

<!-- api-refusal-shapes:start -->
| Part | Required fields |
| --- | --- |
| `envelope` | `version:number`, `error:object` |
| `error` | `code:string`, `message:string`, `next:string` |
<!-- api-refusal-shapes:end -->

`relay on`, `relay`, and `relay off` share the relay result shape. `status` adds a `relay` object with the current sequence and pending upload count. Successful results may include `diagnostics` for a relay refusal or inactivity notice; a local move still succeeds when its upload must wait. Device sign-in instructions are written immediately to stderr, including with `--json`, so the person can sign in before the command returns.

The result and refusal tables are checked against `JSON_SHAPES` in `src/json.js` by `docs/api.test.js`.

## Local HTTP API v1

Run `pullboard serve --port 0` to print a private API address on `127.0.0.1`. Authenticate each call with the address's `k` query parameter, an `X-Pullboard-Key` header, or `Authorization: Bearer <key>`. The secret belongs to that server session. Board ids are random 128-bit values stored in each board; reopening or moving a repo preserves its id.

The server checks any Origin against its own address and grants no CORS permission. JSON request bodies are limited to 100000 bytes; oversized bodies are drained and refused without applying a partial move. A missing or invalid registered folder does not hide readable boards: it appears in `warnings` with its registry display fields and a versioned refusal whose `next` field explains how to restore or forget it.

| Method and path | Result |
| --- | --- |
| `GET /api/v1/boards` | Registered boards with their project details and ids |
| `GET /api/v1/boards/:board/state?seen=N` | The view's board state, including open coordinator requests and the unseen shout count since N |
| `GET /api/v1/boards/:board/code?ref=path:lines@commit&before=...` | A bounded preview of committed file lines from that registered board |
| `GET /api/v1/boards/:board/events?after=N` | Events after sequence N, in order, and their event-log format version |
| `POST /api/v1/boards/:board/moves` | One CLI move and its emitted event |
| `POST /api/v1/boards/:board/requests` | A person's request for the coordinator |

The boards response keeps `boards` and may include `warnings` for registered entries that could not be opened. State `seen` must be a nonnegative safe integer; omitting it retains the `unseen: null` result. Code previews read only a registered repo's committed tree, use a plain commit SHA and at most 60 lines, and never read the working tree. The shared router lets adapters omit the optional code capability; such adapters return the versioned `CODE_NOT_AVAILABLE` refusal.

The local board state and events responses include `eventLogVersion`, which identifies the persisted event-record format separately from the HTTP envelope's `version`. Static view exports keep this field in both state.json and events.json so a reader can refuse a format newer than it understands. Sealed relay events do not use this local board format marker.

The coordinator maintains the roadmap with `milestone add <name> [--note ...] [--items 1,2,3]`, `milestone items <name> --add|--remove ids`, `milestone move <name> --before <other>`, `milestone edit <name> [--name <new>] [--note <text>]`, and `milestone remove <name>`. A milestone stores only its name, optional note, and ordered item ids in `board_meta`; removing a milestone leaves its items untouched. A `repo#id` reference uses a registered repo's display name (or its folder name) before `#`; its status is read from that board when the repo is registered on this machine. `pullboard roadmap` prints milestones in order with a verified-item done count. Its JSON results and API state use `{ name, note, items: [{ id, title, status }], done, total }` for each milestone.

<!-- api-http-shapes:start -->
| Response | Required top-level fields |
| --- | --- |
| `boards` | `version:number`, `boards:array` |
| `state` | `version:number`, `state:object` |
| `events` | `version:number`, `events:array` |
| `move` | `version:number`, `event:object`, `result:object` |
| `request` | `version:number`, `event:object`, `result:object` |
| `stream` | `version:number`, `event:object` |
<!-- api-http-shapes:end -->

A move body is `{verb, item, args, agent}`. `item` is the positive integer id when the move needs one. `args` names its CLI positional arguments and flags; text values stay literal, including leading dashes. Omit `agent` to act as the coordinator, or name a registered agent to run in its worktree. Coordinator verification takes `args.as: "coordinator"`, matching the CLI's explicit identity check. The local session secret may act as any agent on that board. `result` is the CLI's JSON result. `next` claims work atomically; when a claim is already held it renews it and returns the renewal event. With no work available it returns the CLI's `NOTHING_FREE` refusal. Waiting remains a CLI option.

Decision moves keep the CLI's routing: `shout` with `args.decision: true` may omit `args.to`; agents ask their coordinator, and the coordinator asks the person. `pass` takes the decision's id as `item` and `args.note`. Answering a decision addressed to the person requires `answer` with `args.as: "person"` from the coordinator's main checkout. Other callers receive the CLI's refusal.

`spec approve <ids>` and `spec decline <ids> --reason "why"` record the person's exact row decision without writing repo files. Bare ids name SPEC.md rows; `doctrine:<id>` names a repo doctrine row. These commands refuse agent shells and agent worktrees. The authenticated local view uses moves `spec-approve` with `args: {ids: "G1 G2", by: "<optional SSH principal>"}` or `spec-decline` with `args: {ids: "G1", reason: "why"}`, acting through the main checkout. Pending rows keep their source `status` and add `decision` and `stage` (`approved, pending apply` or `declined, pending apply`) in `spec show` and the shared view/API state.

Only the coordinator runs `spec apply`. It preflights every pending row against the exact source text, refusing stale decisions before writing any file. Approval changes the status to `approved`; decline changes it to `wont` with the person's reason as the row text, preserving trailing fields. SSH-enabled approvals carry one signed `row-decision` receipt binding the file, source, replacement, decision, reason and row text. Apply copies that same receipt into `.pullboard/signoffs.jsonl`; it remains a current exact-text sign-off. Commit the changed files and receipts together.

To approve new wording, the person uses `spec approve <one-id> --text "exact proposed text"`, or `spec-approve` with `args: {ids: "G1", text: "exact proposed text"}`. This records the same exact-row receipt; files wait for coordinator apply. Text must be one nonempty line without a field separator. Pre-commit checks the staged row against that person decision or a verified staged SSH sign-off; unstaged receipts cannot authorize a commit.

Doctor and resume report every stale frozen item after cited text changes. Open, claimed and submitted items suggest coordinator refreeze. Verified and merged items keep their receipts, report that they shipped against the old text, and suggest adding a follow-up citing the changed row. Resume JSON includes these findings in `stale`.

The SQLite schema marker is now `PRAGMA user_version = 2`. Opening an older board upgrades it in place: `board_meta` stores the id as `meta_key = "board_id"` and a 32-character hexadecimal `meta_value`; `shout_request` and `shout_request_outcome` mark requests and their answers. Existing items, agents and events remain intact. The HTTP envelope stays at version 1 independently of the SQLite schema marker.

A request body is `{text}`. It creates a request from the person to the coordinator. Open requests stay first in coordinator `resume` and `inbox` until answered `done`, or `declined` with a reason, and do not count as open decisions.

For live events, send `Accept: text/event-stream` to the events path. Each message's `id` is its event sequence and its `data` has the `stream` shape above. Reconnect with `Last-Event-ID` to resume after that sequence; it takes precedence over `after`.

The local server uses a shared HTTP router. Streams recheck access before each poll and close with a versioned refusal if access ends. Slow readers pause delivery and resume from the last delivered sequence.

HTTP refusals use the same versioned error envelope above: 400 for malformed calls, 401 for a missing or wrong session secret, 403 for an agent belonging to another board, 404 for an unknown board or path, and 409 for the CLI engine's refusal. Shouts and answers append their events in the same transaction as their records. A move returns its own event, including when it also sends a coordinator shout.

## SSH spec sign-offs

`pullboard spec signers add [--key <path>] [--by <principal>]` opts a repo into OpenSSH-signed spec sign-offs. The key defaults to Git `user.signingkey`, then `~/.ssh/id_ed25519.pub`. The principal defaults to the exact Git `user.email`; `--by` overrides it. `spec signoff` uses the same email default in a repo with SSH signers, and accepts `--by` when a listed principal differs. A row's `signers:` names those exact principals. Spec checking refuses a required principal without a corresponding signer entry.

The initial command output names `.pullboard/signers`, `.pullboard/first-commit` and `.pullboard/signers.initial` for staging and committing. Later sign-offs and signed signer-list changes are recorded in `.pullboard/signoffs.jsonl`; commit that file with the corresponding signer-list change.

Every signed row and signer-list change binds the initial signer-list hash in its canonical text. Rewriting `.pullboard/signers.initial`, or relabelling that hash in earlier receipts, invalidates those receipts.
