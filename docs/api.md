# CLI JSON API

Add `--json` to a Pullboard command to receive one JSON document on stdout. The document has `version: 1`; diagnostics stay out of stderr. The flag may appear with command options before `--`. A flag after `--` is an argument to the command, not an output-mode switch.

The API version is independent of the package version. Its contract is stable within each major API version: existing command names, required fields, field types, and refusal fields do not change within that version. An incompatible change requires a new `version`. New fields may be added, so clients should ignore fields they do not use.

Decision shouts without a recipient go to the agent's coordinator, or to `person` when sent by the coordinator. An agent may answer a decision sent to its own lane; the reply names that agent and goes to the original asker. An agent in another lane gets `NOT_YOUR_DECISION`. `pullboard pass <shout-id> <note>` is for coordinators: it forwards an open coordinator decision to the person with the original question and note. From the main checkout, `pullboard decisions` and `pullboard answer <shout-id> <text>` default to the coordinator; use `--as person` to select the person's queue or answer a person-addressed decision. Person mode is accepted only in the main checkout. An answer in person mode cannot answer a coordinator-addressed decision, and a coordinator-default answer cannot impersonate the person; the refusal prints the command to retry. A person answer is delivered to the original asker. An agent worktree cannot select person mode.

A successful command returns the fields listed below. `version` is always the number `1`. The catalog lists required top-level fields; nested objects and arrays are command data, and optional top-level fields may be added.

`pullboard settings` reads machine-wide settings from the OS account's `~/.pullboard/settings.json`; the gate queue database is beside it. This location does not follow `HOME` or `PULLBOARD_HOME`, so agents with private board homes still share one machine gate limit. Set `PULLBOARD_MACHINE_HOME` to an explicit directory only when a separate private machine settings and gate pool is intended; tests use this override. `pullboard settings gateSlots <n>` changes the gate queue capacity, which defaults to `2`. Capacity changes are refused while a gate is running or waiting, so existing holders and FIFO order remain intact.

<!-- api-command-shapes:start -->
| Command | Required top-level fields |
| --- | --- |
| `help` | `version:number`, `help:string` |
| `version` | `version:number`, `release:string` |
| `init` | `version:number`, `root:string`, `notes:array` |
| `hooks` | `version:number`, `notes:array` |
| `join` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string` |
| `worktree` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string`, `branch:string`, `prompt:string` |
| `resume` | `version:number`, `me:object`, `all:array`, `requests:array`, `holding:array`, `sentBack:array`, `awaiting:array`, `toVerify:array`, `toMerge:array`, `open:array`, `holds:array`, `unread:number`, `newest:array`, `root:string`, `dirty:number`, `next:string` |
| `whoami` | `version:number`, `id:string`, `lane:string`, `path:string` |
| `lanes` | `version:number`, `lanes:object`, `shared:array`, `coordinator:string` |
| `resources` | `version:number`, `resources:array` |
| `settings` | `version:number`, `settings:object` |
| `relay` | `version:number`, `linked:boolean`, `board:string`, `url:string`, `link:string`, `sequence:number`, `behind:number` |
| `list` | `version:number`, `items:array` |
| `show` | `version:number`, `item_id:number`, `item_title:string`, `item_lane:string`, `item_status:string`, `verdicts:array` |
| `status` | `version:number`, `me:object`, `mine:array`, `stats:object`, `unread:number` |
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
| `hook pre-commit` | `version:number`, `messages:array` |
| `hook commit-msg` | `version:number`, `messages:array` |
| `hook pre-push` | `version:number`, `messages:array` |
<!-- api-command-shapes:end -->

`join` and `worktree` accept an optional free-text `--family` declaration. Rejoining the same worktree preserves its agent id; a supplied family updates the declaration, while omitting `--family` preserves it. `resume` includes it as `me.family`; `show` includes `item_builder_family` and each verdict's `verdict_verifier_family`. These recorded fields are `null` when the agent did not declare a family, and later declarations do not rewrite prior submissions or verdicts.

## Refusals

A refusal keeps the command's existing exit status and prints exactly one versioned document to stdout. In JSON mode stderr stays empty. The command-specific `code` identifies the rule; `message` explains what happened; `next` gives the next step.

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
| `GET /api/v1/boards/:board/events?after=N` | Events after sequence N, in order |
| `POST /api/v1/boards/:board/moves` | One CLI move and its emitted event |
| `POST /api/v1/boards/:board/requests` | A person's request for the coordinator |

The boards response keeps `boards` and may include `warnings` for registered entries that could not be opened. State `seen` must be a nonnegative safe integer; omitting it retains the `unseen: null` result. Code previews read only a registered repo's committed tree, use a plain commit SHA and at most 60 lines, and never read the working tree. The shared router lets adapters omit the optional code capability; such adapters return the versioned `CODE_NOT_AVAILABLE` refusal.

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

The SQLite schema marker is now `PRAGMA user_version = 2`. Opening an older board upgrades it in place: `board_meta` stores the id as `meta_key = "board_id"` and a 32-character hexadecimal `meta_value`; `shout_request` and `shout_request_outcome` mark requests and their answers. Existing items, agents and events remain intact. The HTTP envelope stays at version 1 independently of the SQLite schema marker.

A request body is `{text}`. It creates a request from the person to the coordinator. Open requests stay first in coordinator `resume` and `inbox` until answered `done`, or `declined` with a reason, and do not count as open decisions.

For live events, send `Accept: text/event-stream` to the events path. Each message's `id` is its event sequence and its `data` has the `stream` shape above. Reconnect with `Last-Event-ID` to resume after that sequence; it takes precedence over `after`.

The local server uses a shared HTTP router. Streams recheck access before each poll and close with a versioned refusal if access ends. Slow readers pause delivery and resume from the last delivered sequence.

HTTP refusals use the same versioned error envelope above: 400 for malformed calls, 401 for a missing or wrong session secret, 403 for an agent belonging to another board, 404 for an unknown board or path, and 409 for the CLI engine's refusal. Shouts and answers append their events in the same transaction as their records. A move returns its own event, including when it also sends a coordinator shout.

## SSH spec sign-offs

`pullboard spec signers add [--key <path>] [--by <principal>]` opts a repo into OpenSSH-signed spec sign-offs. The key defaults to Git `user.signingkey`, then `~/.ssh/id_ed25519.pub`. The principal defaults to the exact Git `user.email`; `--by` overrides it. `spec signoff` uses the same email default in a repo with SSH signers, and accepts `--by` when a listed principal differs. A row's `signers:` names those exact principals. Spec checking refuses a required principal without a corresponding signer entry.

The initial command output names `.pullboard/signers`, `.pullboard/first-commit` and `.pullboard/signers.initial` for staging and committing. Later sign-offs and signed signer-list changes are recorded in `.pullboard/signoffs.jsonl`; commit that file with the corresponding signer-list change.

Every signed row and signer-list change binds the initial signer-list hash in its canonical text. Rewriting `.pullboard/signers.initial`, or relabelling that hash in earlier receipts, invalidates those receipts.
