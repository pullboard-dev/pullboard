# CLI JSON API

Add `--json` to a Pullboard command to receive one JSON document on stdout. The document has `version: 1`; diagnostics stay out of stderr except for sign-in instructions and check consent notices that must appear before execution. The flag may appear with command options before `--`. A flag after `--` is an argument to the command, not an output-mode switch.

The API version is independent of the package version. Its contract is stable within each major API version: existing command names, required fields, field types, and refusal fields do not change within that version. An incompatible change requires a new `version`. New fields may be added, so clients should ignore fields they do not use.

Decision shouts without a recipient go to the agent's coordinator, or to `person` when sent by the coordinator. An agent may answer a decision sent to its own lane; the reply names that agent and goes to the original asker. An agent in another lane gets `NOT_YOUR_DECISION`. `pullboard pass <shout-id> <note>` is for coordinators: it forwards an open coordinator decision to the person with the original question and note. From the main checkout, `pullboard decisions` and `pullboard answer <shout-id> <text>` default to the coordinator; use `--as person` to select the person's queue or answer a person-addressed decision. Person mode is accepted only in the main checkout. An answer in person mode cannot answer a coordinator-addressed decision, and a coordinator-default answer cannot impersonate the person; the refusal prints the command to retry. A person answer is delivered to the original asker. An agent worktree cannot select person mode.

A successful command returns the fields listed below. `version` is always the number `1`. The catalog lists required top-level fields; nested objects and arrays are command data, and optional top-level fields may be added.

`pullboard settings` reads machine-wide settings from `~/.pullboard/settings.json`; `pullboard settings gateSlots <n>` changes the gate queue capacity, which defaults to `2`. Capacity changes are refused while a gate is running or waiting, so existing holders and FIFO order remain intact.

When `add` or `edit` supplies a new nonempty check, it records the item before measuring that check in a background temporary checkout of the captured `main` commit. Use `--wait` to wait for the measurement before returning, or `args.wait: true` for an HTTP add/edit move. The item returned by `add`, `edit`, `show`, and `next --verify` may include `item_check_baseline`: `{command, main, result, request?, seconds?, reason?, warning?}`. `main` is the commit id or `null`, and `result` is `pending`, `green`, `red`, or `unavailable`. A background request carries an opaque `request` identity; an older completion cannot overwrite a newly edited or cleared check.

The board-state API's item projection includes `check` and, when recorded, `checkBaseline` with the same observation fields. A green result carries `warning: "CRITERION_PROVES_NOTHING"`; text output names that warning when showing or reserving the item for review, and when filing it with `--wait`. An exact match with the project gate configured at that main commit records green with `reason: "repo gate"` without running it again. A missing main records unavailable with `reason: "no main"` and still files the item. Changing the check replaces this observation; clearing it removes the observation. Captured observations and completions travel through ordered board moves, so replicas store results without executing commands. A completed result awaiting relay delivery stays on the measuring device and is retried by the next normal CLI command.

`pullboard stats [--since <date>] --json` returns `{version: 1, stats: {...}}` from the append-only event log. `submissions` and `rejections` count moves, including repeated attempts; `rejectionShare` is rejections divided by submissions (zero when the window has no submissions). `merged` counts distinct items with a merge move; `mergedWithoutAccept` counts those whose merge lacks an earlier acceptance of the latest submitted commit. That audit uses earlier history even when the acceptance falls before the selected window. Current item and verdict rows do not replace event evidence.

`firstEventAt` and `lastEventAt` are the first and latest dates in the selected window, or `null` when it is empty. `since` is the inclusive boundary as an ISO UTC timestamp, or `null` for the full history. Dates accept `YYYY-MM-DD` or an ISO UTC timestamp ending in `Z`; invalid dates return `BAD_SINCE` with repair guidance.

`agentCount` counts distinct event actors other than `board` and `person`; the coordinator and join moves are included. `agents` lists `{id, moves, families}` for each actor. `families` lists `{name, agents, moves}` by recorded family label, and `familyCount` counts these buckets, including `unknown`. Labels are not inferred from a model name or current agent, item, or verdict rows. A family's first recorded event snapshot applies to that move and following moves, until another snapshot changes or clears it; earlier unattributed moves remain `unknown`. Date windows preserve earlier recorded declarations but count only selected moves. Arrays are sorted by identifier or label. Local HTTP board state carries the same full-history object as `state.proofStats`.

<!-- api-command-shapes:start -->
| Command | Required top-level fields |
| --- | --- |
| `help` | `version:number`, `help:string` |
| `version` | `version:number`, `release:string` |
| `init` | `version:number`, `root:string`, `notes:array` |
| `hooks` | `version:number`, `notes:array` |
| `join` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string` |
| `takeover` | `version:number`, `agent:string`, `path:string` |
| `worktree` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string`, `branch:string`, `prompt:string` |
| `resume` | `version:number`, `me:object`, `all:array`, `requests:array`, `holding:array`, `sentBack:array`, `awaiting:array`, `toVerify:array`, `toMerge:array`, `open:array`, `stale:array`, `holds:array`, `unread:number`, `newest:array`, `root:string`, `dirty:number`, `next:string` |
| `whoami` | `version:number`, `id:string`, `lane:string`, `path:string` |
| `lanes` | `version:number`, `lanes:object`, `shared:array`, `coordinator:string` |
| `resources` | `version:number`, `resources:array` |
| `settings` | `version:number`, `settings:object` |
| `relay` | `version:number`, `linked:boolean`, `board:string`, `url:string`, `link:string`, `sequence:number`, `behind:number`, `recovery:object` |
| `list` | `version:number`, `items:array` |
| `roadmap` | `version:number`, `milestones:array` |
| `milestone add` | `version:number`, `milestone:object` |
| `milestone items` | `version:number`, `milestone:object` |
| `milestone move` | `version:number`, `milestone:object` |
| `milestone edit` | `version:number`, `milestone:object` |
| `milestone remove` | `version:number`, `milestone:object` |
| `show` | `version:number`, `item_id:number`, `item_title:string`, `item_lane:string`, `item_status:string`, `verdicts:array`, `thread:array` |
| `stats` | `version:number`, `stats:object` |
| `status` | `version:number`, `me:object`, `mine:array`, `stats:object`, `reviewQueue:object`, `unread:number`, `relay:object` |
| `doctor` | `version:number`, `problems:array` |
| `inbox` | `version:number`, `shouts:array` |
| `decisions` | `version:number`, `decisions:array` |
| `ledger` | `version:number`, `items:array`, `stats:object` |
| `log` | `version:number`, `events:array` |
| `add` | `version:number`, `item:object` |
| `edit` | `version:number`, `item:object` |
| `fact` | `version:number`, `item:number`, `fact:object` |
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
| `hook pre-merge-commit` | `version:number`, `messages:array` |
| `hook commit-msg` | `version:number`, `messages:array` |
| `hook pre-push` | `version:number`, `messages:array` |
<!-- api-command-shapes:end -->

`hook pre-merge-commit` runs the same staged checks as `hook pre-commit` before Git creates an automatic merge commit. `init` and `hooks` install it; `doctor` names it when absent at Git's effective hook path. Lane ownership comes from `HEAD:pullboard.json`, so an unstaged configuration edit cannot grant a lane new folders. Lane-sensitive checks refuse a repository with `info/grafts` in its Git common directory because grafts alter ancestry even when replacement objects are disabled.

`join` and `worktree` accept an optional free-text `--family` declaration. Rejoining the same worktree preserves its agent id; a supplied family updates the declaration, while omitting `--family` preserves it. `resume` includes it as `me.family`; `show` includes `item_builder_family` and each verdict's `verdict_verifier_family`. These recorded fields are `null` when the agent did not declare a family, and later declarations do not rewrite prior submissions or verdicts.

Each checkout is bound to the first agent session that writes there. The local Git directory holds only its session digest, agent id and timestamp; bindings are absent from board exports and relay snapshots. Another agent session gets `NOT_YOUR_CHECKOUT` and the command to make its own worktree. The same agent starting a new session runs `pullboard takeover`; the existing ordered shout records the takeover, addressed to the person for the main checkout or the coordinator for a lane checkout. Markerless terminals, reads, the view and person requests keep their existing behavior. A shout or decision addressed to its sender is refused with `SELF_SHOUT`.

`status.reviewQueue` contains `pending`, `reviewing` (distinct agents with live review leases), `reserved`, `oldestSubmittedAt` and `ageMs`. Age starts at each outstanding item's latest submit event; reserving or renewing its review does not reset it. An empty queue has `oldestSubmittedAt: null` and `ageMs: 0`. Among unreserved submissions, `awaitingFirstReview` counts items with no release since their latest submission; `releasedWithoutVerdict` counts those released without a verdict. `releasedItems` lists `{item, releases, reason}` with the cumulative release count and latest reason for that submission. Historical releases without a reason show `reason not recorded`.

Releasing a reserved review requires a nonempty one-line `--note` (or `--note-file`); the authenticated release action accepts the same `note` field. A refusal keeps the reservation and records no release. The same reviewer is not offered that submission again until it is resubmitted or an hour passes, while other reviewers remain eligible. Releasing a build claim keeps its existing behavior and does not require a reason.

When outstanding reviews reach `verify.reviewRatio` times the active reviewers (default 3, with zero reviewers counting as one), `next` first offers a review the agent may take. This creates no claim or reservation. Its additive v1 `offer` has the review's `item` id, exact `command` to reserve it, `queue` and `ratio`; `build` previews the otherwise available build or is `null`. `next --verify <id>` reserves explicitly. `next --build` claims explicitly; a fresh claim's event detail records `reviewSkipped` with the offered id (or `null`), ratio and queue snapshot. Renewing an existing claim creates no new skip.

For HTTP `next`, a review offer returns success with `event: null`, `offer` and the ordinary CLI `result`. Send `args.build: true` to claim as before and receive the actual claim event. The unattended `run` command always supplies explicit build intent, records it on fresh claims, and prints the review backlog each iteration.

## Item threads

`pullboard fact <id> <kind> "<text>"` appends a fact to an existing item. The observation kinds are `capture`, `measurement`, `note` and `diff`; any registered agent may append them. The judgement kinds are `decision`, `rejection`, `supersession` and `root-cause`; only the item's live lease holder or the coordinator may append them. An expired lease gives no judgement permission. Facts do not change the item's status or its claim.

The result is `{version: 1, item: <item-id>, fact: {...}}`. A fact has `id` (stable string identity), `eventId` (board-local event sequence), `kind`, exact `text`, `by` (registered author), `at` (UTC timestamp), `ref` and `supersedes`. The board supplies identity, author and time. `ref` and `supersedes` are `null` when omitted.

Use `--ref src/file.js:12-30@<full-40-character-sha>` to bind a fact to a committed code range. A single line is `:12@...`. The reference becomes `{path, start, end, commit}`; paths are relative to the repo, line numbers are positive and ascending, and the commit is lowercase hexadecimal. Short hashes are refused with `BAD_FACT_REF`. Replicas validate this binding without fetching source code.

A correction is a new fact with `--supersedes <fact-id>`. It requires the live holder or coordinator even when its kind is an observation. The earlier fact remains visible; supersession must name a fact on the same item. A missing or cross-item identity is refused with `NO_FACT`. Unsupported kinds receive `BAD_FACT_KIND`, empty text receives `EMPTY_FACT`, and unauthorized judgements or corrections receive `FACT_JUDGEMENT`.

`show --json` retains its existing item fields and verdicts and adds `thread`. The HTTP state item's additive `thread` field has the same array. Entries are oldest first, ordered by the append-only event sequence. A fact entry is `{type: "fact", ...fact}`. A move entry is `{type: "move", eventId, kind, by, at, detail}`, with `detail` holding the original move's structured event detail. Text `show` prints these moves and facts as one timeline, including full references and both sides of a correction. Ordinary verdict summaries and `--history` remain available.

The HTTP move is `{verb: "fact", item: 12, agent: "web-1", args: {kind: "measurement", text: "The check takes 8 seconds", ref: "src/file.js:12-30@<full-sha>"}}`. Omit `agent` to act as the coordinator; `args.supersedes` supplies a correction's earlier fact identity. The response carries the committed `fact` event and the CLI result. The event-log format stays at version 1 because facts use its existing immutable event rows; exports and imports preserve those rows. The sealed move engine advances to version 3 for this release so older engines refuse the new operation before replay.

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

`relay on`, `relay`, and `relay off` share the relay result shape. Successful `pullboard relay recover --skip N` returns that same shape with optional `skipped: N` naming the explicitly refused sequence and `adopted: true` when it adopts a different authenticated person checkpoint that proves the same blocked refusal. Every relay result includes `recovery: { pending, skip, next }`; when a saved recovery is pending, `next` is the exact retry command. The `behind` count remains the number of pending uploads and does not include recovery. `status` includes this relay object alongside the local board summary. Human status and relay output show the recovery sequence and retry command when one is saved. The local `agent_last_shout_id` inbox read cursor is metadata: recovery ignores only that field in its guarded digest and preserves the greater valid cursor for matching agents. Other native changes remain protected; if a semantic local write changes while recovery is pending, the CLI preserves it and refuses automatic restoration. Exporting alone does not unblock that conflict; this prototype has no merge or discard command, so the person must reconcile the export and remote checkpoint before continuing. Successful results may include `diagnostics` for a relay refusal or inactivity notice; a local move still succeeds when its upload must wait. Device sign-in instructions are written immediately to stderr, including with `--json`, so the person can sign in before the command returns.

`relay on --all [--url <address>]` returns `{version, linked: [{project, root, board}], failed: [{project, root, reason}], paired, autoLink: true}`. Its status is nonzero when a project failed; successful links remain available. With no paired phone, the command prints one tappable pairing link and QR, then waits in the foreground up to ten minutes. Interruption or expiration leaves completed links intact and exits zero when no link failed. Every explicit invocation signs in afresh; no person session is retained on the Mac. Later project registrations publish one sealed phone-link proposal and keep working locally until its single approval tap. `doctor` and `resume` name the waiting project and its expiry; expiration requires an explicit fresh sign-in rather than silently asking again. `relay off` excludes that project from automatic linking; explicit `relay on` clears the exclusion.

`relay devices` returns `{version, devices: [{deviceId, label, fingerprint, createdAt}]}` without a private key or credential. `relay revoke <deviceId>` returns `{version, deviceId, revoked: true, notice}` after removing the local recipient and deleting its remote wraps. Native revocation waits for one tap on the paired phone and uses a short-lived, single-use, RAM-only grant for that exact device. A failed or interrupted approval needs an explicit retry. Revocation stops future wrapping; it cannot erase board keys already received.

Phone enrollment uses a one-use `#device=<locator>.<secret>` fragment, removed before sign-in. The secret remains on the phone and Mac. Person-authenticated `/api/v1/devices/session` returns the current account id. `/api/v1/devices/enrollments/:locator` supports POST `{}` to start a ten-minute locator, PUT of the exact public enrollment and MAC, GET of `{version, enrollment}` and DELETE to consume it. A native Mac checks the MAC locally before retaining any recipient. `/api/v1/devices/:deviceId` supports POST `{}` to record an authenticated recipient and DELETE to revoke it. PUT `/api/v1/devices/:deviceId/boards/:boardId` stores `{engine, wrapped}`; GET `/api/v1/devices/:deviceId/boards` returns `{version, wraps: [{board, engine, wrapped}]}` filtered by current board access. `wrapped` is opaque base64url client ciphertext. Enrollment, device listing and direct revocation require a person session. A board-scoped machine credential can PUT only its own board wrap to an already enrolled device. Cookie writes require the exact configured Origin, and all responses are no-store. Device ids and grants belong to the authenticated GitHub account. Revoked ids cannot be registered or uploaded again.

`POST /auth/machines {board,machine}` requires a foreground person session and returns a `pm_` credential bound to that board and machine. This delegate can mint board-scoped `pa_` tokens through `/auth/tokens` and list only its board’s token ids and metadata. It cannot link a board, issue a machine credential, post a phone request, revoke another credential directly, or use person-only cookie endpoints. Agent tokens cannot mint any credential.

A machine publishes an opaque approval with `POST /api/v1/devices/approvals {context,sealed}`. The publishing machine may GET only its own requests. The paired phone reads `/api/v1/devices/:deviceId/approvals`, explicitly POSTs `/:requestId/authorize {}` and completes the encrypted reply through `/:requestId/complete {response}`. The publishing machine executes a native revocation through `/:requestId/execute {grant}`; the two-minute grant binds the entire context and is atomically consumed once. Native reply keys and grants never persist. A refused foreground approval fails immediately with the original refusal code and reason plus its request id. A refused remote approval makes local unlinking or registration exit nonzero while retaining the completed local work: one line names that completion, the refusal code and reason, the request id and the next action. The JSON result preserves the local outcome and includes `remote: {code, reason, requestId}`. New-board linking uses a durable non-person reply key and returns only a board-scoped machine credential. `relay off` immediately unlinks locally even offline or in an agent shell, reports that the relay copy remains, and queues a separate one-tap phone deletion request when possible.

The result and refusal tables are checked against `JSON_SHAPES` in `src/json.js` by `docs/api.test.js`.

When `verify <id> accept` runs a frozen check and refuses with `CHECK_RED` or `CHECK_UNVERIFIED`, `error.message` includes its output digest, up to 40 sanitized tail lines, and `full output file: <path>`. The file is written with owner-only permissions. If diagnostic storage fails, the message says `full output file: (unavailable: CODE)` while retaining the bounded sanitized lines; the JSON error object remains `{ code, message, next }`. An item with no frozen check produces no check-output section.

## Local HTTP API v1

Run `pullboard serve --port 0` to print a private API address on `127.0.0.1`. Authenticate each call with the address's `k` query parameter, an `X-Pullboard-Key` header, or `Authorization: Bearer <key>`. The secret belongs to that server session. Board ids are random 128-bit values stored in each board; reopening or moving a repo preserves its id.

The server checks any Origin against its own address and grants no CORS permission. JSON request bodies are limited to 100000 bytes; oversized bodies are drained and refused without applying a partial move. A missing or invalid registered folder does not hide readable boards: it appears in `warnings` with its registry display fields and a versioned refusal whose `next` field explains how to restore or forget it.

| Method and path | Result |
| --- | --- |
| `GET /api/v1/boards` | Registered boards with their project details and ids |
| `GET /api/v1/boards/:board/state?seen=N` | The view's board state, including open coordinator requests and the unseen shout count since N |
| `GET /api/v1/boards/:board/shouts/:id` | One shout from any point in the board's history, including its decision and answer fields |
| `GET /api/v1/boards/:board/code?ref=path:lines@commit&before=...` | A bounded preview of committed file lines from that registered board |
| `GET /api/v1/boards/:board/events?after=N` | Events after sequence N, in order, and their event-log format version |
| `POST /api/v1/boards/:board/moves` | One CLI move and its emitted event |
| `POST /api/v1/boards/:board/requests` | A person's request for the coordinator |

The boards response keeps `boards` and may include `warnings` for registered entries that could not be opened. State `seen` must be a nonnegative safe integer; omitting it retains the `unseen: null` result. State continues to include only the newest 40 shouts. Use `GET /api/v1/boards/:board/shouts/:id` to resolve an older address; its `{ shout }` result contains the complete stored shout row, including sender, recipient, text, timestamp, decision flag and reply relationship. Decision shouts also include `decision_state` (`open` or `answered`) and `decision_answer` (the reply row or `null`); other shouts use `null` for both fields. A missing id returns `NO_SHOUT` with HTTP 404; malformed ids are refused with HTTP 400. Code previews read only a registered repo's committed tree, use a plain commit SHA and at most 60 lines, and never read the working tree. The shared router lets adapters omit the optional code capability; such adapters return the versioned `CODE_NOT_AVAILABLE` refusal.

Core readers can call `allShouts(board)` for every stored shout, oldest first, without advancing any agent's unread cursor. Static exports can use that read to retain text for old shout addresses. Relay snapshots carry the same history only inside their authenticated, encrypted presentation; the relay service receives no plaintext shout history. Older presentations without complete history return `SHOUT_NOT_AVAILABLE`; refresh them with a current CLI.

The local board state and events responses include `eventLogVersion`, which identifies the persisted event-record format separately from the HTTP envelope's `version`. Static view exports keep this field in both state.json and events.json so a reader can refuse a format newer than it understands. Sealed relay events do not use this local board format marker.

The coordinator maintains the roadmap with `milestone add <name> [--note ...] [--items 1,2,3]`, `milestone items <name> --add|--remove ids`, `milestone move <name> --before <other>`, `milestone edit <name> [--name <new>] [--note <text>]`, and `milestone remove <name>`. A milestone stores only its name, optional note, and ordered item ids in `board_meta`; removing a milestone leaves its items untouched. A `repo#id` reference uses a registered repo's display name (or its folder name) before `#`; its status is read from that board when the repo is registered on this machine. `pullboard roadmap` prints milestones in order with a verified-item done count. Its JSON results and API state use `{ name, note, items: [{ id, title, status }], done, total }` for each milestone.

<!-- api-http-shapes:start -->
| Response | Required top-level fields |
| --- | --- |
| `boards` | `version:number`, `boards:array` |
| `state` | `version:number`, `state:object` |
| `shout` | `version:number`, `shout:object` |
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

HTTP refusals use the same versioned error envelope above: 400 for malformed calls, 401 for a missing or wrong session secret, 403 for an agent belonging to another board, 404 for an unknown board, path or shout, and 409 for the CLI engine's refusal. Shouts and answers append their events in the same transaction as their records. A move returns its own event, including when it also sends a coordinator shout.

## SSH spec sign-offs

`pullboard spec signers add [--key <path>] [--by <principal>]` opts a repo into OpenSSH-signed spec sign-offs. The key defaults to Git `user.signingkey`, then `~/.ssh/id_ed25519.pub`. The principal defaults to the exact Git `user.email`; `--by` overrides it. `spec signoff` uses the same email default in a repo with SSH signers, and accepts `--by` when a listed principal differs. A row's `signers:` names those exact principals. Spec checking refuses a required principal without a corresponding signer entry.

The initial command output names `.pullboard/signers`, `.pullboard/first-commit` and `.pullboard/signers.initial` for staging and committing. Later sign-offs and signed signer-list changes are recorded in `.pullboard/signoffs.jsonl`; commit that file with the corresponding signer-list change.

Every signed row and signer-list change binds the initial signer-list hash in its canonical text. Rewriting `.pullboard/signers.initial`, or relabelling that hash in earlier receipts, invalidates those receipts.

## Sealed person requests

The authenticated relay page calls `cockpitPage` with `readOnly: true` and the separate `requests: true` capability. This enables only the person's literal intents through the sealing transport; generic API writes remain refused. Local read-only pages and exported snapshots omit this capability and refuse every action.

A paired relay browser translates `add`, `shout`, `answer`, `hold` (including `args.off: true`), `spec-approve` and `spec-decline` into literal CLI intent. Its transport accepts `{verb, item?, args}` at the paired board's moves address and seals a separate request document before posting `{sequence, sealed}` to `/api/v1/boards/:board/requests`. It never sends plaintext arguments, an engine operation or the board key. The relay stores and orders that opaque envelope; it neither executes a command nor writes a repository. Agent credentials cannot submit person intent or person-attributed holds and releases.

The device-only request format is `{version: 1, type: "person-request", id, move: {verb, item?, args}}`. This request version is independent of the ordinary move engine version. The stable `id` survives interrupted sends and sequence collisions. Browser storage keeps each pending request's ciphertext separately, so another tab cannot replace or clear it. A later board read reconciles pending sends with the relay's acknowledged prefix before retrying.

The next ordinary local Pullboard command receives requests in relay order. One linked native device claims each request for ten minutes, measured exclusively from relay receipt timestamps, and runs its literal arguments through the actual CLI in the coordinator's primary checkout, outside the relay lock. Lane, brief, spec, person-channel and other CLI checks run there. Receiving a request never calls an engine operation directly. Its committed result travels as an ordinary move; durable request and move receipts prevent command retries from applying that result twice. A restarted device resumes its durable stages. After the executor lease expires, another linked device may claim the waiting request; each executor has distinct move ids, while the request’s atomic result and status prevent a late executor from creating another effect. Network or sign-in failures leave the request waiting.

Local `GET /api/v1/boards/:board/state` and the device-decrypted relay presentation expose additive `state.personRequests`. Each entry has:

| Field | Meaning |
| --- | --- |
| `id` | Stable request identity |
| `sequence`, `at` | Original relay position and timestamp |
| `by` | `person` for authenticated person intent; a refused sender names its authenticated actor |
| `move` | Literal `{verb, item?, args}`, or `null` for refused malformed input |
| `status` | `waiting`, `done` or `refused` |
| `error` | Present for refusal: the original `{code, message, next}` CLI guidance, or a typed format/sender refusal |
| `result`, `resultSequence` | Optional committed ordinary-move result and its relay position |
| `coordinatorRequest` | Optional local shout id for a repository-change request |

A browser action's decoded response is `{version: 1, event, result: {request}}`; `request` has the same status shape. `event` is the opaque acknowledgement, or `null` when reconciliation finds the earlier acknowledgement already in a sealed checkpoint. Direct actions become `done` when their actual CLI move commits. A refused add, for example, retains `UNKNOWN_SPEC` and the same explanation and next step as the terminal command, without creating an item. Answers always use the person channel; holds and releases keep the coordinator's execution guard while attributing the decision and event to the person.

Row approval and decline first record the person's exact decision through the same authenticated view boundary as the local view, without editing any file. They then create a person-to-coordinator request to run `spec apply`. That request is first in coordinator `resume` and `inbox`. Its status stays `waiting` until the coordinator applies it and answers `done`, or answers `declined <reason>`. Decline resolves the request as `refused` with `REQUEST_DECLINED`, the coordinator's reason and a next step. The browser and relay never run `spec apply`.

`pullboard hold <id> "reason"` holds one open or claimed item; `pullboard hold <id> --off` lifts that hold. Both retain the `hold` JSON shape (`lane`, `held`) and add `id` and `reason` (null when lifted). Held open items are skipped by `next` and refuse new claims with `ITEM_HELD`; an existing live holder can renew and submit. `show` and `list` include the hold actor and reason. Successful `next --json` results may include `reasons` naming skipped holds.
