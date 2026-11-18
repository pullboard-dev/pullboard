# Static view export

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
