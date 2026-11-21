# CLI JSON API

The API version is independent of the package version. Its contract is stable within each major API version: existing command names, required fields, field types, and refusal fields do not change within that version. An incompatible change requires a new `version`. New fields may be added, so clients should ignore fields they do not use.

Decision shouts without a recipient go to the agent's coordinator, or to `person` when sent by the coordinator. An agent may answer a decision sent to its own lane; the reply names that agent and goes to the original asker. An agent in another lane gets `NOT_YOUR_DECISION`. `pullboard pass <shout-id> <note>` is for coordinators: it forwards an open coordinator decision to the person with the original question and note. From the main checkout, `pullboard decisions` and `pullboard answer <shout-id> <text>` default to the coordinator; use `--as person` to select the person's queue or answer a person-addressed decision. Person mode is accepted only in the main checkout. An answer in person mode cannot answer a coordinator-addressed decision, and a coordinator-default answer cannot impersonate the person; the refusal prints the command to retry. A person answer is delivered to the original asker. An agent worktree cannot select person mode.

In a repo whose `pullboard.json` names a `project`, `pullboard decisions --as person` lists the open person decisions of every registered repo of that project, each named `repo#id`, and `pullboard answer repo#id <text> --as person` answers one on its own board, so the decision closes there and nowhere else. Its JSON carries `project` and each decision's `repo`; a repo whose board cannot be read is named in `unreadable` and the others still list. `GET /api/v1/decisions?board=<id>` returns the same list from the local API: `{version, project, decisions}` for the project of the named registered board, with each decision's `board` id and `repo`; without a project it lists that board alone. Answer through that board's `moves` path.

## Command result shapes

<!-- api-command-shapes:start -->
| Command | Required top-level fields |
| --- | --- |
| `help` | `version:number`, `help:string` |
| `version` | `version:number`, `release:string` |
| `init` | `version:number`, `root:string`, `notes:array`, `proposedLanes:array`, `mcp:object` |
| `hooks` | `version:number`, `notes:array` |
| `join` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string`, `model:string`, `displayName:string` |
| `takeover` | `version:number`, `agent:string`, `path:string` |
| `worktree` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string`, `branch:string`, `prompt:string`, `model:string`, `displayName:string` |
| `resume` | `version:number`, `me:object`, `all:array`, `requests:array`, `holding:array`, `sentBack:array`, `awaiting:array`, `toVerify:array`, `toMerge:array`, `open:array`, `stale:array`, `doctrineNotes:array`, `holds:array`, `unread:number`, `newest:array`, `root:string`, `newWorktreeLocation:string`, `dirty:number`, `next:string` |
| `whoami` | `version:number`, `address:string`, `id:string`, `lane:string`, `path:string`, `model:string`, `displayName:string` |
| `agents` | `version:number`, `agents:array` |
| `lanes` | `version:number`, `lanes:object`, `shared:array`, `coordinator:string` |
| `lane add` | `version:number`, `lane:string`, `owns:array` |
| `resources` | `version:number`, `resources:array` |
| `settings` | `version:number`, `settings:object` |
| `runner` | `version:number`, `runner:object` |
| `relay` | `version:number`, `linked:boolean`, `board:string`, `url:string`, `link:string`, `sequence:number`, `behind:number`, `recovery:object` |
| `sync` | `version:number`, `ref:string`, `sequence:number`, `pending:string\|null` |
| `list` | `version:number`, `items:array` |
| `move` | `version:number`, `source:string`, `destination:string`, `moveId:string`, `item:object` |
| `queue` | `version:number`, `releases:array`, `unreleased:array`, `first:object` |
| `map` | `version:number`, `main:string`, `map:string` |
| `flow replay` | `version:number`, `history:object`, `replay:object` |
| `roadmap` | `version:number`, `milestones:array` |
| `milestone add` | `version:number`, `milestone:object` |
| `milestone focus` | `version:number`, `focus:string\|null`, `overflow:boolean` |
| `milestone items` | `version:number`, `milestone:object` |
| `milestone order` | `version:number`, `milestone:object` |
| `milestone pin` | `version:number`, `milestone:object` |
| `milestone sink` | `version:number`, `milestone:object` |
| `milestone lift` | `version:number`, `milestone:object` |
| `milestone move` | `version:number`, `milestone:object` |
| `milestone edit` | `version:number`, `milestone:object` |
| `milestone remove` | `version:number`, `milestone:object` |
| `milestone ship` | `version:number`, `milestone:object`, `into:string\|null`, `moved:array`, `notMoved:array` |
| `companion` | `version:number`, `item:object`, `created:boolean` |
| `patch` | `version:number`, `item:number` |
| `patch attach` | `version:number`, `item:number`, `key:string`, `digest:string`, `changed:boolean` |
| `patch list` | `version:number`, `item:number`, `patches:array`, `digest:string\|null` |
| `patch remove` | `version:number`, `item:number`, `key:string`, `digest:string`, `changed:boolean` |
| `show` | `version:number`, `item_id:number`, `item_title:string`, `item_lane:string`, `item_status:string`, `verdicts:array`, `thread:array`, `reviewEligibility:object` |
| `capacity` | `version:number`, `report:object` |
| `stats` | `version:number`, `stats:object`, `gateWaits:array`, `usage:object` |
| `badge` | `version:number`, `items:number`, `checked:number`, `percent:number\|null`, `changed:array` |
| `status` | `version:number`, `me:object`, `mine:array`, `capacityForecast:object`, `ruleCounts:object`, `stats:object`, `reviewQueue:object`, `unread:number`, `relay:object` |
| `doctor` | `version:number`, `problems:array` |
| `health` | `version:number`, `asOf:string`, `thresholds:object`, `stuck:array`, `waiting:array` |
| `sentinel propose` | `version:number`, `sentinel:object` |
| `sentinel approve` | `version:number`, `sentinel:object` |
| `sentinel decline` | `version:number`, `sentinel:object` |
| `sentinels` | `version:number`, `sentinels:array` |
| `loop` | `version:number`, `jobs:array` |
| `loop declare` | `version:number`, `job:object` |
| `loop ran` | `version:number`, `job:object` |
| `skills` | `version:number`, `updated:array`, `current:array`, `customized:array` |
| `inbox` | `version:number`, `shouts:array` |
| `request` | `version:number`, `requests:array` |
| `decisions` | `version:number`, `decisions:array` |
| `ledger` | `version:number`, `items:array`, `stats:object` |
| `log` | `version:number`, `events:array` |
| `flakes` | `version:number`, `flakes:array`, `unclassified:array`, `regressions:array`, `stable:array` |
| `flakes rerun` | `version:number`, `flakes:object`, `file:string` |
| `rigor` | `version:number`, `causes:array`, `uncaused:number` |
| `rigor draft` | `version:number`, `key:string`, `reads:string`, `evidence:object`, `proof:object`, `drafts:array` |
| `add` | `version:number`, `item:object` |
| `edit` | `version:number`, `item:object` |
| `fact` | `version:number`, `item:number`, `fact:object` |
| `why` | `version:number`, `id:number`, `decisions:array` |
| `why file` | `version:number`, `file:string`, `line:number\|null`, `items:array`, `rows:array`, `decisions:array` |
| `why release` | `version:number`, `release:string\|null`, `asOf:string`, `items:array`, `idle:array`, `landings:object` |
| `escalate` | `version:number`, `id:number`, `from:string`, `to:string` |
| `run` | `version:number`, `messages:array` |
| `sweep` | `version:number`, `messages:array` |
| `next` | `version:number`, `item:object`, `review:boolean`, `held:boolean`, `shared:array` |
| `check` | `version:number`, `id:number`, `green:boolean`, `seconds:number`, `check:string`, `receipt:object`, `report:string` |
| `test` | `version:number`, `green:boolean`, `output:string`, `counts:object`, `failures:array`, `logPath:string`, `runner:string`, `seconds:number`, `files:array`, `known:array`, `main:string\|null` |
| `check accept` | `version:number`, `id:number`, `digest:string`, `check:string` |
| `claim` | `version:number`, `id:number`, `renewed:boolean`, `leaseUntil:string`, `digest:string` |
| `hold` | `version:number`, `lane:string`, `held:boolean` |
| `release` | `version:number`, `id:number` |
| `submit` | `version:number`, `id:number`, `commit:string`, `pin:string`, `gate:object` |
| `done` | `version:number`, `id:number`, `commit:string`, `pin:string`, `gate:object` |
| `verify` | `version:number`, `id:number`, `decision:string`, `reason:string` |
| `verify compare` | `version:number`, `item:number`, `status:string` |
| `merged` | `version:number`, `id:number`, `commit:string` |
| `land` | `version:number`, `batch:object\|null`, `landed:array`, `conflicts:array`, `blocked:array`, `culprits:array`, `flakes:array` |
| `withdraw` | `version:number`, `id:number`, `reason:string`, `milestones:array` |
| `refreeze` | `version:number`, `id:number`, `after:string` |
| `reopen` | `version:number`, `id:number`, `commit:string` |
| `shout` | `version:number`, `id:number`, `decision:boolean` |
| `answer` | `version:number`, `id:number`, `answers:number` |
| `pass` | `version:number`, `id:number`, `answers:number` |
| `tour` | `version:number`, `messages:array` |
| `lifecycle` | `version:number`, `markdown:string` |
| `view` | `version:number`, `url:string`, `port:number` |
| `view export` | `version:number`, `path:string` |
| `serve` | `version:number`, `url:string`, `port:number` |
| `watch` | `version:number`, `sequence:number`, `kind:string`, `item:number\|null`, `actor:string\|null`, `detail:string` |
| `forget` | `version:number`, `root:string` |
| `prompt` | `version:number`, `role:string`, `text:string` |
| `gate` | `version:number`, `green:boolean`, `report:string` |
| `gate set` | `version:number`, `gate:string`, `file:string` |
| `export` | `version:number`, `tables:object` |
| `digest` | `version:number`, `markdown:string`, `capacityForecast:object`, `bytes:number`, `sequence:number`, `sections:array` |
| `import` | `version:number`, `tables:array` |
| `spec` | `version:number`, `rows:array` |
| `spec check` | `version:number`, `rows:array` |
| `spec view` | `version:number`, `path:string` |
| `spec show` | `version:number`, `row:object`, `standing:object` |
| `blueprint starters` | `version:number`, `blueprint:object`, `starters:array` |
| `spec draft` | `version:number`, `id:string`, `row:object` |
| `blueprint add` | `version:number`, `blueprint:object`, `section:string`, `rows:array`, `items:array`, `gate:string\|null`, `proposedLanes:array` |
| `blueprint fit` | `version:number`, `proposals:array` |
| `spec fit` | `version:number`, `proposals:array` |
| `spec unmet` | `version:number`, `rows:array` |
| `spec signoff` | `version:number`, `count:number`, `by:string`, `ids:array`, `evidence:array` |
| `spec signers` | `version:number`, `added:boolean`, `by:string`, `path:string`, `initial:boolean` |
| `spec approve` | `version:number`, `decisions:array` |
| `spec decline` | `version:number`, `decisions:array` |
| `spec answer` | `version:number`, `decisions:array` |
| `spec apply` | `version:number`, `applied:array`, `files:array` |
| `doctrine check` | `version:number`, `rules:array` |
| `hook pre-commit` | `version:number`, `messages:array` |
| `hook pre-merge-commit` | `version:number`, `messages:array` |
| `hook commit-msg` | `version:number`, `messages:array` |
| `hook pre-push` | `version:number`, `messages:array` |
| `tool-build` | `version:number`, `build:object\|null` |
| `cells` | `version:number`, `cells:array`, `unsealed:array` |
| `compact` | `version:number`, `days:number`, `jobs:number`, `rows:number`, `before:number`, `after:number` |
| `contribute` | `version:number`, `file:string`, `shape:string`, `ok:boolean`, `failures:array` |
| `explain` | `version:number`, `table:string`, `guards:array`, `outcomes:array` |
| `field` | `version:number`, `field:object` |
| `flow tune` | `version:number`, `windowMinutes:number`, `cycle:object`, `choice:object`, `constraints:array` |
| `heartbeat` | `version:number`, `seat:string\|null`, `presence:string`, `heartbeatAt:string\|null` |
| `labels` | `version:number`, `labels:array`, `unmet:array` |
| `link` | `version:number`, `link:string`, `parent:object`, `child:object`, `disclosure:string` |
| `maintenance` | `version:number`, `enabled:boolean`, `counts:object`, `pruned:number`, `archived:number` |
| `mark` | `version:number`, `mark:object` |
| `mutate` | `version:number`, `cell:string`, `all:boolean`, `redBefore:array`, `tests:array`, `faults:array`, `caught:number`, `missed:number` |
| `red` | `version:number`, `file:string` |
| `replay` | `version:number`, `table:string`, `days:number`, `agreed:number`, `disagreed:number`, `beforeCut:number`, `disagreements:array` |
| `route` | `version:number`, `suggest:string`, `items:array` |
| `rules` | `version:number`, `rulesVersion:number`, `judged:number`, `agreed:number`, `rate:number`, `disagreements:array`, `disagreementCount:number`, `kinds:array`, `final:object`, `readiness:object` |
| `search` | `version:number`, `query:string`, `matches:array` |
| `seats` | `version:number`, `seats:array` |
| `stats agents` | `version:number`, `agents:object` |
| `stats disk` | `version:number`, `disk:object` |
| `stats moves` | `version:number`, `moves:object` |
| `stats pipeline` | `version:number`, `pipeline:object` |
| `stats review` | `version:number`, `review:object` |
| `stats runners` | `version:number`, `runners:object` |
| `stats time` | `version:number`, `time:object`, `checkpoint:string\|null` |
| `timeline` | `version:number`, `summary:object` |
| `trace` | `version:number`, `subject:string`, `since:string\|null`, `entries:array` |
| `update` | `version:number`, `current:boolean`, `from:string`, `to:string` |
<!-- api-command-shapes:end -->

## Refusals

<!-- api-refusal-shapes:start -->
| Part | Required fields |
| --- | --- |
| `envelope` | `version:number`, `error:object` |
| `error` | `code:string`, `message:string`, `next:string` |
<!-- api-refusal-shapes:end -->

## Local HTTP API v1

Run `pullboard serve --port 0` to print a private API address on `127.0.0.1`. Authenticate each call with the address's `k` query parameter, an `X-Pullboard-Key` header, or `Authorization: Bearer <key>`. The secret belongs to that server session. Board ids are random 128-bit values stored in each board; reopening or moving a repo preserves its id.

The server checks any Origin against its own address and grants no CORS permission. JSON request bodies are limited to 100000 bytes; oversized bodies are drained and refused without applying a partial move. A missing or invalid registered folder does not hide readable boards: it appears in `warnings` with its registry display fields and a versioned refusal whose `next` field explains how to restore or forget it.

| Method and path | Result |
| --- | --- |
| `GET /api/v1/health` | Answered on the request thread from what it holds, never through a handler: `{ok: true}`, plus under `pullboard serve` `pool: {workers, busy, queued, oldestMs}` for the handler worker pool. |
| `GET /api/v1/settings?board=id` | Local-only read-only inventory: machine settings plus all authorized boards, or the selected board. Each row has `key`, `scope`, `value`, `default`, `source`, and `origin`; repo/board rows also identify `board` and `root`. Credential rows carry `secret: true` and only `set` or `not set`. Runtime events, queues and cached relay payloads are excluded. |
| `GET /api/v1/boards` | Registered boards with their project details and ids |
| `POST /api/v1/projects/forget-unreadable` | Local view only, with the view session key in `x-pullboard-key`. Body exactly `{"confirm": true}`. Forgets the registered boards this machine can no longer find (`BOARD_UNAVAILABLE`) and returns `{version, forgotten}`; a board refused for a newer schema is kept. Refuses `BAD_REQUEST` for any other body, `VIEW_SIGN_IN_AUTH` without the key. |
| `GET /api/v1/boards/:board/state?seen=N` | The board state, listing item summaries, including open coordinator requests and the unseen shout count since N |
| `GET /api/v1/boards/:board/state?detail=full` | The same state with every item in full, which static view exports read |
| `GET /api/v1/boards/:board/state?since=N` | What changed in the summary state since the snapshot this server sent at event N, and the new latest sequence |
| `GET /api/v1/boards/:board/state?items=compact&finished=omit` | A compact snapshot with only open, claimed and submitted items, `finished: {verified, withdrawn}` counting the rest and `itemsOmitted: "finished"` naming what it left out; applying a delta to it skips any item it was never sent. Refused without `items=compact` or with `since` |
| `GET /api/v1/boards/:board/finished` | `{version: 1, sequence, state}`: the verified and withdrawn items, compact-encoded as `items=compact` is, for a screen that shows them |
| `GET /api/v1/boards/:board/summary` | `{version: 1, summary}`: the board's counts (`building`, `awaiting`, `sentBack`, `open`, `verified`), the person's calls (`decisions`, `pending`, `drafts`, `holds`), `sequence` and `lastChange {at, eventId}`, under 2 KB however large the board, from the last built state without waiting for a rebuild. Each row of `GET /api/v1/boards` carries `summaryVersion: 1` when the server serves it |
| `GET /api/v1/boards/:board/state?kept=1` | A snapshot from the state the server keeps, at once, even when a later write is still being built; a first load that then catches up through `since=N`. Refused with `since` |
| `GET /api/v1/boards/:board/cost-analytics?window=today&#124;7d&#124;30d` | Private local Cost analytics for the selected window; unavailable to hosted and relay clients |
| `GET /api/v1/boards/:board/proofs/:id` | One item’s full flow proof record, authenticated like board state |
| `GET /api/v1/boards/:board/items/:id` | One item's full detail: the fields its summary leaves out |
| `GET /api/v1/boards/:board/agents/:id` | One seat read from the agent and item rows, no state build: `agent_id`, `agent_lane`, `agent_route` and `claimed`, the ids it holds with a live lease; `NO_AGENT` when the seat is not registered |
| `GET /api/v1/boards/:board/items?q=text` | The ids of the items whose id, title, lane, spec ids or criterion contain the text, ignoring case |
| `GET /api/v1/boards/:board/shouts/:id` | One shout from any point in the board's history, including its decision and answer fields |
| `GET /api/v1/boards/:board/tokens` | This linked board's agent-token metadata |
| `POST /api/v1/boards/:board/tokens` | Revoke one token named by its opaque id |
| `POST /api/v1/boards/:board/jobs` | The runner job queue, only when `gate.runnerDispatch` is `pull` (`JOBS_NOT_PULL` otherwise). Body `{action: "claim", runner, capabilities, kinds?}` returns `{claim, trunk}`: the oldest open job whose needs the runner has, with its candidate commit, its `run` argv and a lease token, or `null`; `trunk` is the board's `trunk.remote` setting (else the board host's repository), where `pullboard runner serve` fetches the candidate. `renew`, `release` and `receipt` (with `{receipt}`) name `{job, runner, token}`; a token that is not the job's current claim is refused `JOB_LEASE_MOVED`. A lapsed lease reopens the job for the next claim. Under `pullboard serve` each call runs in a handler worker pool; with every worker busy past a 1 s wait it is refused `API_BUSY` (HTTP 503), and a request-thread stall over 500 ms is recorded as an `api_stall` board event naming its route. |
| `GET /api/v1/boards/:board/trunk/:id.pack` | The runner's trunk fetch, where `:id` is the full hex commit id a job names: a git pack of that trunk commit's objects (`application/x-git-packed-objects`, never cached). `BAD_REQUEST` for a non-commit id or a method other than GET, `NO_COMMIT` when the trunk lacks the commit, and `TRUNK_PACK_NOT_AVAILABLE` (404) when the board serves no packs; fetch from the `trunk.remote` setting instead. |
| `GET /api/v1/machine` | Local view only: this machine's resource and handoff-queue reading as `{version: 1, machine}`, with `machine: null` when it cannot be read. Send the view's session key in the `x-pullboard-key` header, with no query string or `Authorization` header (`VIEW_SIGN_IN_AUTH` otherwise); any method but GET is refused `BAD_REQUEST` (HTTP 405). |
| `GET /api/v1/compat-cells` | Local view only, read only: the compat cells of the root runs file as a JSON list of stage groups (`claim`, `submit`, `gate`, `review`, `accept`, `land`), each with its `cells` (a node run shows as `{language, outcome, run}` with its run id). Send the view's session key in the `x-pullboard-key` header, with no query string or `Authorization` header (`VIEW_SIGN_IN_AUTH` otherwise); any method but GET is refused `BAD_REQUEST` (HTTP 405). |
| `GET /api/v1/boards/:board/code?ref=path:lines@commit&before=...` | A bounded preview of committed file lines from that registered board |
| `GET /api/v1/boards/:board/events?after=N` | Events after sequence N, in order, and their event-log format version |
| `GET /api/v1/events?boards=<id>,<id>` | One live stream of every named board's events and changed signals, each tagged with its board |
| `POST /api/v1/boards/:board/moves` | One CLI move and its emitted event |
| `POST /api/v1/boards/:board/requests` | A person's request for the coordinator (view only) |
| `GET /api/v1/view-link` | Whether the full-machine view can start device sign-in |
| `POST /api/v1/view-link` | Start, inspect, cancel or continue device sign-in in that view |

The boards response keeps `boards` and may include `warnings` for registered entries that could not be opened. State `seen` must be a nonnegative safe integer; omitting it retains the `unseen: null` result. State continues to include only the newest 40 shouts. Use `GET /api/v1/boards/:board/shouts/:id` to resolve an older address; its `{ shout }` result contains the complete stored shout row, including sender, recipient, text, timestamp, decision flag and reply relationship. Decision shouts also include `decision_state` (`open` or `answered`) and `decision_answer` (the reply row or `null`); other shouts use `null` for both fields. A missing id returns `NO_SHOUT` with HTTP 404; malformed ids are refused with HTTP 400. Code previews read only a registered repo's committed tree, use a plain commit SHA and at most 60 lines, and never read the working tree. The shared router lets adapters omit the optional code capability; such adapters return the versioned `CODE_NOT_AVAILABLE` refusal.

`GET /api/v1/boards/:board/items/:id` returns `{item}`: the item's `id` and every field its summary leaves out, which are `owner`, `reviewer`, `reviewUntil`, `verifiedBy`, `criterion`, `brief`, `commit`, `merged`, `history`, `check`, `checkBaseline` when recorded, `verdicts`, `thread`, and the latest `verdict` in full. Laid over its summary, the detail is the item exactly as the full state carries it. An unknown id returns `NO_ITEM` with HTTP 404; a malformed id is refused with HTTP 400. `state?detail=full` returns every item in full, summary fields included, and `detail=summary` returns summaries; any other value is refused with `BAD_REQUEST`. Without `detail`, a server answers with its own default, `stateDetail: "summary"` or `"full"`: `serveApi`, which `pullboard serve` runs, defaults to summaries, and `createLocalApiHandler`, which a page's own server builds, defaults to full items until that page reads summaries. `GET /api/v1/boards/:board/items?q=text` returns `{ids}`, in state order, for the items whose `#id`, title, lane, spec ids or criterion contain the trimmed text, ignoring case, as the view's search matches; empty text matches every item. An adapter without these reads returns `ITEM_NOT_AVAILABLE`. The paired API2 phone transport implements these reads by decrypting addressed pages; its initial state is bounded and full detail follows separately.

`GET /api/v1/boards/:board/proofs/:item` returns `{version: 1, proof}` with that item's full flow report (the corresponding record formerly in `proofStats.flow.report.items`). It uses the same board authentication as state and item reads; unknown items return 404, malformed ids and writes are refused. Adapters without proof reads, or a known item whose derived report is unavailable, return `ITEM_NOT_AVAILABLE` rather than a fabricated record. A normal writable board command rebuilds missing derived reports; unknown items remain 404.

A server keeps, in memory only, the fingerprints of the last 24 summary states it sent for each board, as snapshots or as a delta's result; a read of one item or a search sends no snapshot, so it never makes a base. When it cannot extend the client's snapshot, `delta` is `null` and `reset` says why, with `{code, message, next}`: `BASE_NOT_KEPT` when it never sent a snapshot at N or has forgotten it, as after a restart; `BASE_AHEAD` when N is past the board's latest event; and `FORMAT_CHANGED` when the request's optional `eventLogVersion` differs from the server's. The client then loads a fresh snapshot. `since` must be a nonnegative integer (`BAD_CURSOR` otherwise), works with `seen`, and is refused with `detail=full`; an adapter without deltas, such as the relay, returns `DELTA_NOT_AVAILABLE`.

### Response shapes

<!-- api-http-shapes:start -->
| Response | Required top-level fields |
| --- | --- |
| `boards` | `version:number`, `boards:array` |
| `state` | `version:number`, `state:object` |
| `delta` | `version:number`, `since:number`, `sequence:number`, `delta:object\|null` |
| `shout` | `version:number`, `shout:object` |
| `item` | `version:number`, `item:object` |
| `items` | `version:number`, `ids:array` |
| `events` | `version:number`, `events:array` |
| `move` | `version:number`, `event:object`, `result:object` |
| `request` | `version:number`, `event:object`, `result:object` |
| `stream` | `version:number`, `event:object` |
<!-- api-http-shapes:end -->

For live events, send `Accept: text/event-stream` to the events path. Ordinary messages have an `id` equal to their event sequence and `data` has the `stream` shape above. The local server also sends `event: changed` with `data: {"version":1,"event":{"event_kind":"changed"}}` when a view input changes without a board event; that notification has no `id` and does not move the reconnect cursor. Add `?signals=none` to the events path to receive events only: the server then sends no `changed` notification and builds no state revision for that client. Reconnect with `Last-Event-ID` to resume after the last ordinary event sequence; it takes precedence over `after`.

To follow several boards on one connection, send `Accept: text/event-stream` to `GET /api/v1/events?boards=<id>,<id>`, naming each board once by its id from `GET /api/v1/boards`. A browser holds at most six connections per origin, so a project group's view follows all its repos through this one stream. Each frame's `data` also names its `board`: an event is `{"version":1,"board":"<id>","event":{...}}`, and the changed signal is `{"version":1,"board":"<id>","event":{"event_kind":"changed"}}`, sent on the same terms as a single board's. An ordinary event's `id` carries one cursor per board, `<id>:<sequence>` pairs joined by commas, so reconnecting with `Last-Event-ID`, or passing the same cursor as `after`, resumes each board where it left off. A followed board the cursor leaves out starts from its first event, and a pair for a board not followed is ignored. Every named board must be one the caller may read: otherwise the request is refused with that board's refusal, naming the board, and nothing is streamed. The path is live only; a request without `Accept: text/event-stream` is refused with `BAD_REQUEST`. The single-board events path is unchanged.
