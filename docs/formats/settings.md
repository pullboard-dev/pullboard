# Recorded board line settings

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
