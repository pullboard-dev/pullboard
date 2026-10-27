/**
 * The item lifecycle, declared once (M1).
 *
 * Every state an item can be in, every move between states, who may make it, and the guards it
 * must pass in the order they are checked, each guard with the refusal it raises and the step that
 * gets past it. Final states carry exit guards that every move into them must name (M2), so no
 * command can become a second way into verified or withdrawn. `machineProblems` proves the
 * declaration's properties (M4); test/machine.test.js runs it, shows each property failing on a
 * broken copy, and checks the declaration against the refusals board.js and cli.js raise today.
 */

export * from './engine-metadata.js';

/** @typedef {'agent' | 'coordinator' | 'clock'} Role */

/**
 * @typedef {object} Guard
 * @property {string} id - How moves name it.
 * @property {string} refuse - The refusal code it raises when it does not hold.
 * @property {{ code: string, next: string }[]} [alsoRefuses] - Additional typed refusals and their repair steps.
 * @property {string} rule - What must hold, in words.
 * @property {string} next - The step that gets past it.
 * @property {'board' | 'cli'} source - Where its fact comes from: the board file, or the CLI's look at git and the worktree.
 * @property {string} [when] - For a guard that applies only in some cases: when it is checked.
 */

/**
 * @typedef {object} State
 * @property {string} id
 * @property {string} means
 * @property {boolean} [final] - Nothing leaves it.
 * @property {string[]} requires - Item fields that are set whenever an item is in this state.
 * @property {{ says: string, sql: string }} [proof] - What must exist before an item enters it, as an
 *   SQL condition on NEW, the item row being written; the board file itself checks it (M3).
 */

/**
 * @typedef {object} Move
 * @property {string} verb
 * @property {string[]} from - The states it starts from.
 * @property {string} to
 * @property {Role[]} by - Who may make it.
 * @property {string[]} guards - Checked in this order. IN_STATE marks where the item's state is checked.
 * @property {string} [refuse] - The code raised when the item is in none of `from`.
 * @property {{ code: string, rule: string, next: string }[]} [alsoRefuses] - Other typed refusals from the command result path.
 * @property {string[]} [sets] - The fields it sets.
 * @property {string} [command] - The command that makes it.
 * @property {string} [when] - For the clock's move: when it happens.
 */

/**
 * @typedef {object} Machine
 * @property {Role[]} roles
 * @property {string} initial - The state every item starts in.
 * @property {Record<string, 'append' | 'keep'>} records - Tables the board keeps for good: rows only
 *   ever added (append), or rows never deleted (keep).
 * @property {State[]} states
 * @property {Guard[]} guards
 * @property {Move[]} moves
 * @property {Record<string, string[]>} exitGuards - Per target state, guards every move into it must name.
 * @property {{ refuse: string, rule: string, next: string }} unknownMove - The refusal for a move that does not exist.
 */

/** The guard id that marks where a move checks the item's state; its code is the move's own. */
export const IN_STATE = 'inState';

/** @type {Role[]} */
export const ROLES = ['agent', 'coordinator', 'clock'];

/** Where every item starts. */
export const INITIAL = 'open';

/**
 * What the board file keeps for good: the event log and verdicts are only ever added to (R2, V8),
 * and an item is withdrawn, never deleted.
 *
 * @type {Record<string, 'append' | 'keep'>}
 */
export const RECORDS = { event: 'append', verdict: 'append', item: 'keep' };

/** @type {State[]} */
export const STATES = [
  { id: 'open', means: 'waiting for a builder; claimable once what it waits on is verified', requires: [] },
  { id: 'claimed', means: 'an agent holds it under a lease, its criterion frozen', requires: ['item_owner', 'item_lease_until', 'item_frozen_digest'] },
  { id: 'submitted', means: 'a native build gated green, or an intaken outside commit awaiting sandbox verification, at a pinned commit', requires: ['item_built_by', 'item_commit', 'item_frozen_digest'] },
  {
    id: 'verified', means: 'another agent accepted it at the submitted commit, its canonically recorded trunk-only merge, or the item carries an attributed source-board acceptance', requires: ['item_verified_by', 'item_commit'],
    proof: {
      says: 'an ACCEPT on the frozen criterion by its independent verifier at this commit or bound by an ordered merge-only receipt, or an authenticated destination move attesting to an exact source acceptance',
      sql: "EXISTS (SELECT 1 FROM verdict v WHERE v.item_id = NEW.item_id AND v.verdict_decision = 'ACCEPT' AND v.verdict_digest = NEW.item_frozen_digest AND v.verdict_by = NEW.item_verified_by AND v.verdict_by <> NEW.item_built_by AND (v.verdict_commit = NEW.item_commit OR EXISTS (SELECT 1 FROM event e WHERE e.item_id = NEW.item_id AND e.event_kind = 'merge-only-accept' AND json_extract(e.event_detail,'$.verdict') = v.verdict_id AND json_extract(e.event_detail,'$.commit') = NEW.item_commit AND json_extract(e.event_detail,'$.tree') = NEW.item_tree AND json_extract(e.event_detail,'$.digest') = NEW.item_frozen_digest AND json_extract(e.event_detail,'$.by') = v.verdict_by))) OR EXISTS (SELECT 1 FROM board_meta r WHERE r.meta_key = 'rehome_import:' || NEW.item_id AND json_extract(r.meta_value, '$.sourceBoardId') IS NOT NULL AND json_extract(r.meta_value, '$.sourceItemId') IS NOT NULL AND json_extract(r.meta_value, '$.moveId') IS NOT NULL AND json_extract(r.meta_value, '$.attestedBy') IS NOT NULL AND json_extract(r.meta_value, '$.sourceMoveDigest') IS NOT NULL AND json_extract(r.meta_value, '$.sourceReceipt.resultDigest') = json_extract(r.meta_value, '$.sourceMoveDigest') AND json_extract(r.meta_value, '$.verdict.decision') = 'ACCEPT' AND json_extract(r.meta_value, '$.verdict.commit') = NEW.item_commit AND json_extract(r.meta_value, '$.verdict.digest') = NEW.item_frozen_digest AND json_extract(r.meta_value, '$.verdict.by') = NEW.item_verified_by AND json_extract(r.meta_value, '$.verdict.by') <> NEW.item_built_by)",
    },
  },
  { id: 'withdrawn', final: true, means: 'nobody should build it; the reason stays on it', requires: ['item_withdrawn_reason'] },
];

/** @type {Guard[]} */
export const GUARDS = [
  { id: 'sourceAcceptance', refuse: 'REHOME_VERDICT', rule: 'the authenticated destination mover attests to an exact source board ACCEPT reference keyed by the ordered source MOVEID and result digest', next: 'preserve the imported source acceptance attribution, frozen digest, commit and verifier reference', source: 'board' },
  { id: 'mergeOnlyRecorded', refuse: 'MERGE_ONLY_PROOF', rule: 'the sealed submit records the origin’s Git-derived carry, unchanged bar and original verifier; landing re-proves its heads, trees and resolution hash before merging', next: 'submit normally for outside review if the origin cannot prove the merge', source: 'board' },
  { id: 'outsideSubmission', refuse: 'OUTSIDE_SOURCE', rule: 'an outside author and exact fetched commit/tree are recorded with a trusted frozen criterion, without pretending a native builder gated it', next: 'fetch and intake the exact GitHub pull request again', source: 'board' },
  { id: IN_STATE, refuse: '', rule: "the move can start from the item's current state", next: 'pullboard show <id>', source: 'board' },
  { id: 'joined', refuse: 'NOT_JOINED', alsoRefuses: [{ code: 'AGENT_REPLACED', next: 'read the takeover and only shout on its exact hand-off item; continue work from the incoming agent worktree' }, { code: 'SESSION_LEDGER', next: 'make the agent-session ledger named in the message readable and writable by this user, then run the command again' }], rule: 'the caller is the main checkout, or an unreplaced worktree seat that joined a lane; an agent session\'s claims, submits and verdicts can be checked against its local ledger', next: 'pullboard join <lane> --model "<model name>" (see: pullboard lanes)', source: 'cli' },
  { id: 'itemExists', refuse: 'NO_ITEM', alsoRefuses: [{ code: 'ITEM_MOVED', next: 'use the recorded destination reference shown in the refusal; do not move the old ID again' }], rule: 'the item exists and has not been moved', next: 'pullboard list --all', source: 'board' },
  { id: 'reopenAuthority', refuse: 'COORDINATOR_ONLY', rule: 'the coordinator reopens, the native board computes an automatic submitted-head conflict, or the exact accepting reviewer withdraws its verdict; older recorded submitted-conflict moves keep their joined-seat authority', next: 'ask the coordinator or the reviewer who recorded the accept', source: 'board', alsoRefuses: [{ code: 'NO_POLICY', next: 'restore the local Git configuration so the current trunk can be read, then compute a fresh automatic return' }, { code: 'GIT_GRAFTS', next: 'ask the coordinator to remove the replica graft file, then resume the same move' }, { code: 'GIT_REPLACE_REFS', next: 'ask the coordinator to remove the replica replacement refs, then resume the same move' }, { code: 'VERDICT_WITHDRAW_FORBIDDEN', next: 'ask the accepting reviewer or coordinator to withdraw the verdict' }, { code: 'VERDICT_WITHDRAW_STATE', next: 'refresh the item; only a current acceptance before landing can be withdrawn' }] },
  { id: 'coordinatorOnly', refuse: 'COORDINATOR_ONLY', rule: 'the caller is the coordinator', next: 'run it from the main checkout', source: 'board' },
  { id: 'roadmapReadable', refuse: 'MILESTONES_CORRUPT', alsoRefuses: [{ code: 'LINE_SETTING_RANGE', rule: 'the recorded board line-order setting has a valid registry value', next: 'restore the recorded board line setting from its ordered event history, then retry next --verify' }], rule: 'the recorded queue policy and roadmap are readable when selecting the next review', next: 'restore board metadata from a known-good board export', source: 'board', when: 'only next --verify selection; a review reserved by id does not consult the roadmap' },
  { id: 'coordinatorSaysAs', refuse: 'MAIN_IS_COORDINATOR', rule: 'in the main checkout, the caller says it is the coordinator', next: 'verify from your own worktree; the coordinator adds --as coordinator', source: 'cli' },
  { id: 'holderOrCoordinator', refuse: 'NOT_YOURS', rule: 'the caller holds the item, or is the coordinator', next: 'shout its holder, or the coordinator', source: 'board' },
  { id: 'releaseOwnsWork', refuse: 'NOT_YOURS', rule: 'the caller holds the claim or is the builder yielding its active first-refusal window', next: 'release your own claim or reservation, or ask the current builder', source: 'board' },
  { id: 'isHolder', alsoRefuses: [{ code: 'OUTSIDE_NATIVE_BUILD', next: 'the outside author revises the PR; ask the coordinator to return it, then intake the new exact head' }], refuse: 'NOT_YOURS', rule: 'the caller holds the claim', next: 'pullboard claim <id>', source: 'board' },
  { id: 'inLane', alsoRefuses: [{ code: 'OUTSIDE_NATIVE_BUILD', next: 'the outside author revises the PR; ask the coordinator to return it, then intake the new exact head' }], refuse: 'WRONG_LANE', rule: "the item is in the caller's lane; the main checkout builds coordinator-lane items only", next: "cd <the lane's worktree> && pullboard claim <id>", source: 'board' },
  { id: 'routeAllows', refuse: 'ROUTE', rule: "the caller's route covers the item's: light, then mid, then strong", next: 'pullboard next, which offers only items your route covers', source: 'board' },
  { id: 'dependenciesVerified', refuse: 'BLOCKED', rule: 'every item it waits on is verified', next: 'claim another item, or shout the lane it waits on', source: 'board' },
  { id: 'builderFirstRefusal', refuse: 'REOPEN_HELD_FOR_BUILDER', rule: 'a returned item waits for its original builder until its recorded deadline or builder release', next: 'wait until the named deadline, or ask its builder to run pullboard release <id>', source: 'board' },
  { id: 'notHeldByAnother', refuse: 'HELD', rule: 'no other agent holds it under a live lease', next: 'pullboard next', source: 'board' },
  { id: 'laneOpen', refuse: 'LANE_HELD', rule: 'nobody holds its lane', next: 'pullboard next --wait 9 (minutes)', source: 'board', when: 'unless the caller is renewing its own live claim' },
  { id: 'itemNotHeld', refuse: 'ITEM_HELD', rule: 'the coordinator has not put this item on hold', next: 'the coordinator lifts it with pullboard hold <id> --off', source: 'board', when: 'unless the caller is renewing its own live claim' },
  { id: 'correctionRefrozen', refuse: 'PENDING_REFREEZE', rule: 'no coordinator correction to a claimed criterion or check is waiting to be frozen', next: 'pullboard refreeze <id>', source: 'board' },
  { id: 'lineCapacity', refuse: 'LINE_WIP_LIMIT', alsoRefuses: [{ code: 'LINE_SETTING_RANGE', next: 'restore the malformed recorded line setting before claiming' }], rule: 'a new claim stays within recorded WIP per active reviewer', next: 'review the oldest eligible waiting submission: pullboard next --verify', source: 'board', when: 'only for new claims while wipPerReviewer is on' },
  { id: 'oneLiveClaim', refuse: 'ONE_CLAIM', rule: 'the caller holds no other live top-level claim, reworks of its own rejected items aside', next: 'submit or release the other item first; child items are free', source: 'board' },
  { id: 'rowsInForce', refuse: 'UNKNOWN_SPEC', alsoRefuses: [{ code: 'A5_GRAMMAR_VERSION', next: 'upgrade Pullboard or use a file written for grammar 1' }, { code: 'NO_POLICY', next: 'restore the committed coordinator policy' }, { code: 'BAD_CONFIG', next: 'repair and commit the coordinator configuration' }, { code: 'SPEC_BEHIND_MAIN', next: 'merge main from this worktree, then retry the claim' }, { code: 'AGENT_APPROVAL_REQUIRED', next: 'ask the coordinator to arrange the person’s confirmation or decline, or change the explicit refuse setting' }, { code: 'BAR_NOT_READY', next: 'another parent session signs coverage for the current accepted test inventory and runner' }], rule: 'every row the item cites exists and is in force', next: 'fix the spec, or the coordinator withdraws the item', source: 'board', when: 'only where the criterion freezes: claiming an item with no frozen criterion, and refreeze' },
  { id: 'criterionUnchanged', refuse: 'CRITERIA_CHANGED', rule: 'the criterion and the rows it cites read as they did at claim', next: 'the coordinator runs pullboard refreeze <id>', source: 'cli' },
  { id: 'treeClean', refuse: 'DIRTY', rule: 'the worktree has no uncommitted changes', next: 'commit your changes, then submit', source: 'cli' },
  { id: 'nothingUntracked', refuse: 'UNTRACKED', rule: 'the worktree has no untracked files', next: 'commit or ignore them, then submit', source: 'cli' },
  { id: 'hasCommit', refuse: 'NO_COMMIT', alsoRefuses: [{ code: 'HOST_NAME', next: 'reword the named commit\'s message without this machine\'s name (git rebase -i, then reword), then run pullboard submit <id> again' }], rule: 'there is a commit to submit, and no commit it adds names this machine', next: 'commit your work, then submit', source: 'cli' },
  { id: 'gateConfigured', refuse: 'NO_GATE', rule: 'the repo names a gate command', next: 'in the main checkout, run pullboard gate set "<project test command>", then commit pullboard.json', source: 'cli' },
  { id: 'withinLane', refuse: 'OUTSIDE_LANE', alsoRefuses: [{ code: 'NO_POLICY', next: 'restore the claim base or ask the coordinator to refreeze' }, { code: 'BAD_CONFIG', next: 'restore the committed coordinator configuration' }, { code: 'GIT_GRAFTS', next: 'ask the coordinator to remove the Git graft file before retrying' }], rule: 'the full claimed diff respects committed coordinator ownership', next: 'restore foreign paths or shout their owner', source: 'cli' },
  { id: 'trunkMergeClean', refuse: 'MERGE_CONFLICT', alsoRefuses: [{ code: 'MERGE_CHECK_FAILED', next: 'use Git 2.38 or newer, restore its objects and retry' }, { code: 'NO_POLICY', next: 'restore the primary repository metadata' }, { code: 'NO_TRUNK', next: 'check out the trunk branch in the main checkout once and run pullboard inbox' }], rule: 'the candidate merges cleanly into the current primary branch without changing an index or worktree', next: 'merge the trunk into your branch, resolve conflicts, commit and resubmit', source: 'cli' },
  { id: 'trunkInCandidate', refuse: 'MAIN_NOT_COMPOSED', rule: 'the candidate contains the current main used for its submission proof, and that main stays fixed through execution', next: 'merge main, commit the composition, then submit again', source: 'cli', when: 'bar ready is enabled for this board' },
  { id: 'noUnverifiedStack', refuse: 'STACKED_ON_UNVERIFIED', rule: "the candidate range contains no other item's unverified submitted commit", next: 'wait for that item to be accepted, or rebuild without its commits', source: 'cli' },
  { id: 'infraExplained', refuse: 'INFRA_NOTE_REQUIRED', rule: 'edits to tests or gate files that existed at claim carry an explanation', next: 'pullboard submit <id> --infra "<why>"', source: 'cli' },
  { id: 'doctrineHolds', refuse: 'RATCHET_ROSE', alsoRefuses: [{ code: 'RATCHET_UNCOUNTED', next: 'fix the check so it exits 0 or 1 within its timeout, then submit again' }], rule: "every touched doctrine check counts (exit 0 or 1), none rises above its committed count and no changed file gains a problem; watch-mode rules only count", next: "fix the new problems, commit, submit again; only the person's signature raises count:", source: 'cli', when: 'only when accepted main has an approved doctrine rule with gate: check' },
  { id: 'itemCheckGreen', refuse: 'CHECK_RED', alsoRefuses: [{ code: 'RUNNER_RESULT_INVALID', next: 'inspect the retained transport diagnostic and repair the named protocol or capsule failure before retrying' }, { code: 'RUNNER_WAIT_DEADLINE', next: 'check the runners the message names, or restore local gate capacity with pullboard settings, then retry' }, { code: 'RUNNER_BROWSER_SLOT_REQUIRED', next: 'nothing to do: the run reruns on a local gate slot; if it repeats, set gate.browserByLaunch the same on this machine and that runner' }, { code: 'RUNNER_GUI_SESSION_REQUIRED', next: 'nothing to do: the run reruns locally; log in to a GUI session on the runner before sending GUI-marked files there' }, { code: 'SANDBOX_PROVIDER_REQUIRED', next: 'configure the committed main Docker provider and pinned minimum/current images' }, { code: 'SANDBOX_IMAGE_REQUIRED', next: 'preload the exact pinned official image into the configured daemon' }, { code: 'SANDBOX_RUNTIME', next: 'correct the pinned image so its actual Node version matches its role' }, { code: 'SANDBOX_EXPORT', next: 'restore access to the exact private Git export and recorded tree' }, { code: 'SANDBOX_EXECUTION', next: 'restore the Docker runtime and inspect the owned container before another verification' }, { code: 'SANDBOX_CLEANUP_REQUIRED', next: 'remove the exact named owned container after restoring Docker' }, { code: 'SANDBOX_CHECK_REQUIRED', next: 'set a trusted full gate and frozen criterion before intake' }, { code: 'CHECK_NO_PROOF', next: 'strengthen the criterion so it fails before the outside change' }, { code: 'OUTSIDE_SANDBOX_REQUIRED', next: 'verify the outside item with --sandbox using the configured container provider' }, { code: 'SLOT_DB_LOCKED', next: 'the run never started, so it is not a red; rerun the same command once the named process releases the slot database' }, { code: 'TIMING_SLOT_REQUIRED', next: 'start the timing check outside its inherited ordinary lease and acquire the machine gate with timing true' }, { code: 'CHECK_UNVERIFIED', next: 'restore the frozen install or check environment and retry' }, { code: 'GUARD_CANNOT_FAIL', next: 'reject: the check stays green with the named guard reverted' }, { code: 'GUARD_NOT_FOUND', next: 'the named guard is not in the submitted commit; ask the coordinator to fix it' }], rule: 'the frozen item check passes at the submitted commit, or its clean reviewed composition for a stale acceptance', next: 'reject the failing behavior; the builder fixes and resubmits', source: 'cli' },

  { id: 'barReady', refuse: 'BAR_NOT_READY', rule: 'an opted-in new bar has a named red baseline, measurement notes, reviewer edges and a revision-bound signature from another parent session', next: 'the author completes the brief, then another parent runs pullboard bar sign <id>', source: 'board', when: 'bar ready is on and this bar was frozen or edited after activation' },
  { id: 'checkProvesSomething', refuse: 'CRITERION_PROVES_NOTHING', rule: "the item's check does not already pass on main, or the person accepted that exact check", next: 'set a check that fails before the work, or the person runs pullboard check accept <id>', source: 'cli', when: 'only when accepted main sets checks.provesNothing to "hold"' },
  { id: 'gateGreen', refuse: 'GATE_RED', alsoRefuses: [{ code: 'RUNNER_WAIT_DEADLINE', next: 'check the runners the message names, or restore local gate capacity with pullboard settings, then retry' }, { code: 'RUNNER_GUI_SESSION_REQUIRED', next: 'nothing to do: the run reruns locally; log in to a GUI session on the runner before sending GUI-marked files there' }, { code: 'LAND_TIMEOUT_CUSTODY', next: 'inspect the saved timed gate cleanup state and stop only its proven owned processes before starting another landing' }, { code: 'LAND_GATE_OUTPUT', next: 'inspect the retained timed gate output directory and free disk space, then start another landing' }, { code: 'SLOT_DB_LOCKED', next: 'the run never started, so it is not a red; rerun the same command once the named process releases the slot database' }, { code: 'TIMING_SLOT_REQUIRED', next: 'start the timing check outside its inherited ordinary lease and acquire the machine gate with timing true' }, { code: 'RUNNER_BROWSER_SLOT_REQUIRED', next: 'nothing to do: the run reruns on a local gate slot; if it repeats, set gate.browserByLaunch the same on this machine and that runner' }, { code: 'PIPEFAIL_UNAVAILABLE', next: 'rewrite the gate without a pipe' }], rule: 'the item check is green; submission proof is green or every failure matches exact main or a live person waiver', next: 'fix what the digest names, commit, submit again', source: 'cli' },
  { id: 'queuedItemLease', refuse: 'ITEM_LEASE_LOST', alsoRefuses: [{ code: 'A5_GRAMMAR_VERSION', next: 'upgrade Pullboard or restore a spec written for grammar 1, then retry' }, { code: 'SPEC_BEHIND_MAIN', next: 'merge main into this worktree, then renew the claim and retry' }, { code: 'NOT_A_REPO', next: 'restore the worktree Git metadata, then retry the command' }, { code: 'NO_CONFIG', next: 'restore pullboard.json in this worktree, then retry the command' }], rule: 'the caller still owns the same live item claim or review and can renew it against the frozen criterion', next: 'claim or reserve the item again before retrying the command', source: 'cli', when: 'while submit or an accept waits for a machine slot, and once immediately before admission' },
  { id: 'proofRecorded', refuse: 'PROOF_RUN_UNAVAILABLE', alsoRefuses: [{ code: 'PROOF_RUN_UNBOUND', next: 'restore the native gate receipt; do not supply provenance by hand' }, { code: 'PROOF_RUN_ACTOR', next: 'use the receipt from your own seat' }, { code: 'PROOF_RUN_STALE', next: 'read the changed criterion before running a new proof' }, { code: 'PROOF_RUN_CHANGED', next: 'keep the original receipt and run a new proof' }], rule: 'every executed proof is recorded from its native gate receipt before the item outcome', next: 'restore receipt storage and read pullboard show <id>', source: 'cli' },
  { id: 'treeStillDuringGate', refuse: 'MOVED_DURING_GATE', rule: 'when the gate ends, HEAD and every tracked file are as they were when it started', next: 'leave the worktree alone until the gate finishes, then submit again', source: 'cli' },
  { id: 'childrenDone', refuse: 'CHILDREN_OPEN', rule: 'every child item is verified or withdrawn', next: 'finish the child items, or the coordinator withdraws them', source: 'board' },
  { id: 'headIsNew', refuse: 'HEAD_NOT_NEW', rule: 'a verifier has not rejected this commit at this bar; after a no-verdict reopen, the bar was refrozen', next: 'commit the rework, or refreeze the bar after a no-verdict reopen before resubmitting the same commit', source: 'board' },
  { id: 'atSubmittedCommit', refuse: 'NOT_AT_COMMIT', alsoRefuses: [{ code: 'OUTSIDE_LANE', next: 'restore foreign paths before accepting' }, { code: 'NO_POLICY', next: 'restore the frozen policy objects' }, { code: 'BAD_CONFIG', next: 'repair the committed coordinator configuration' }, { code: 'GIT_GRAFTS', next: 'ask the coordinator to remove the Git graft file before retrying' }], rule: "the caller's checkout contains the submitted commit", next: 'git switch --detach <commit>', source: 'cli' },
  { id: 'verdictReviewRecorded', refuse: 'BAD_VERDICT_REVIEW', rule: 'a new review binds the submitted commit, its exact checked commit, a valid trunk commit and canonical candidate paths', next: 'restore the submitted Git objects and retry the review with current Pullboard', source: 'board' },
  { id: 'reviewTreeCurrent', refuse: 'STALE_VERDICT', alsoRefuses: [{ code: 'DIRTY', next: 'commit the reviewed composition before re-reviewing' }, { code: 'UNTRACKED', next: 'commit or ignore untracked files before re-reviewing' }, { code: 'VERDICT_TRUNK_MOVED', next: 'merge the latest main and re-review the clean composition' }], rule: 'a stale acceptance is re-reviewed at a clean HEAD containing the current trunk, which stays fixed through its check', next: 'merge current main into the submitted commit and re-review it', source: 'cli' },
  { id: 'notBuilder', refuse: 'SELF_VERIFY', alsoRefuses: [{ code: 'VERIFIER_STANDING', next: 'the coordinator makes an independent verifier from the main checkout: pullboard worktree <lane> --model "<model name>"' }, { code: 'SELF_SESSION_VERIFY', next: 'ask another agent session to verify it: pullboard next --verify from that session\'s own worktree' }], rule: 'the decision’s verifier did not build it, and its agent session did not build or submit it under any seat; a carried verdict retains its original native authority while rechecking all author identities; for a fresh review on a linked board, at engine 48 or newer, the caller was enrolled through the relay by a line of creating seats from the coordinator that includes neither the builder nor a machine join', next: 'another agent verifies it: pullboard next --verify', source: 'board' },
  { id: 'policyAllows', refuse: 'COORDINATOR_VERIFIES', rule: "the repo's verify policy lets the caller verify this lane's work", next: 'the coordinator verifies it', source: 'board' },
  { id: 'familyAllows', refuse: 'O2_FAMILY_MATCH', rule: 'the builder and verifier have different declared families; an undeclared family counts as a match', next: 'ask the coordinator for a verifier from another declared family', source: 'board', when: 'only when verify.family is require' },
  { id: 'reviewFree', refuse: 'REVIEW_HELD', rule: 'no other agent holds its review under a live lease', next: 'pullboard next --verify, which passes over reviews another agent holds', source: 'board' },
  { id: 'reasonIsMet', refuse: 'BAD_REASON', rule: 'an accept gives CRITERION_MET as its reason', next: 'a failed criterion is a reject: pullboard verify <id> reject --reason CODE', source: 'board' },
  { id: 'proofNoted', refuse: 'PROOF_REQUIRED', rule: 'an accept notes how it was proved', next: '--note "what you broke or which edge you tried, and what happened"', source: 'board' },
  { id: 'reasonCoded', refuse: 'BAD_REASON', rule: 'a reject names one of the reject reasons', next: '--reason TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD or OTHER', source: 'board' },
  { id: 'reviewReleaseExplained', refuse: 'NOTE_REQUIRED', rule: 'a review release gives a nonempty one-line reason', next: 'release with --note "why", or --note-file <file>', source: 'board', when: 'engine 5 or newer, only when freeing a submitted review reservation' },
  { id: 'reviewCooldownElapsed', refuse: 'REVIEW_COOLDOWN', rule: 'the reviewer has not released this submission within the past hour', next: 'let another reviewer take it, or wait an hour or for a new submission', source: 'board', when: 'engine 5 or newer, only for the same reviewer and current submission' },
  { id: 'noteGiven', refuse: 'NOTE_REQUIRED', rule: 'the move carries a note: what failed, what was tried, or why', next: '--note "..." or --note-file <file>', source: 'board' },
  { id: 'causeWellFormed', refuse: 'BAD_CAUSE', rule: 'a cause, when given, is test:<file>::<title>, refusal:<CODE>, row:<id>, doctrine:<id> or sentinel:<name>', next: 'fix --cause, or leave it out', source: 'board' },
  { id: 'notMerged', refuse: 'ALREADY_MERGED', rule: 'the item has no recorded merge receipt', next: 'a merged item cannot be reopened', source: 'board' },
  { id: 'submissionProofValid', refuse: 'SUBMISSION_PROOF', rule: 'recorded test selection names literal project files and its full-fallback policy', next: 'rerun submit with the current CLI', source: 'board', when: 'engine 38 or later; absent legacy selection remains unknown' },
  { id: 'landingFailureRecorded', refuse: 'LANDING_FAILURE_REQUIRED', rule: 'a verified item note names the failing test and landing merge commit', next: 'cite the recorded batch, or name the test and merge commit in a manual note; work that only conflicts with the trunk reopens with --conflict <file> for each conflicting file', source: 'board', when: 'unless the reopen names a trunk conflict' },
  { id: 'trunkConflicts', refuse: 'NOT_CONFLICTING', alsoRefuses: [{ code: 'CONFLICT_FILES', next: 'name only files Git reports as conflicting with the trunk' }, { code: 'NO_TRUNK', next: 'check out the trunk branch in the main checkout once and run pullboard inbox' }, { code: 'MERGE_CHECK_FAILED', next: 'use Git 2.38 or newer, restore its objects and retry' }], rule: 'the accepted commit no longer merges onto the trunk, and every named file is one that conflicts', next: 'merge it, or reopen after a red landing with --note "<test file>: <test name>; merge commit <sha>"', source: 'cli', when: 'only for reopen --conflict by the coordinator on accepted, unmerged work' },
  { id: 'conflictAccepted', refuse: 'NOT_ACCEPTED', alsoRefuses: [{ code: 'BAD_CONFLICT', next: 'run pullboard reopen <id> --conflict <file> from the main checkout' }, { code: 'ENGINE_VERSION', next: 'upgrade Pullboard on every linked device before using --conflict' }], rule: 'a trunk conflict reopens an accepted item, names its files and the full trunk commit, and replays only under engine 52 or later', next: 'reopen a submission with --note "why"', source: 'board', when: 'only for reopen --conflict' },
];

/** Shared named item-grant refusals reachable through native dispatch. */
const AGENT_GRANT_REFUSALS = [
  { code: 'AGENT_GRANT_EXPIRED', rule: 'an item mutation has a live claim or review grant', next: 'claim the intended item, or shout the coordinator if its claim is unavailable' },
  { code: 'AGENT_GRANT_ITEM', rule: 'an item mutation belongs to the current claim or review grant', next: 'finish or release the claim, then claim the intended item; use shout for coordination' },
  { code: 'AGENT_GRANT_LANE', rule: 'an item mutation stays inside the unclaimed seat lane', next: 'join a seat in the intended lane or ask its owner to make the item change' },
];

/** A restore may only lift guards whose installed complete shape has its valid stamp. */
const BOARD_SHAPE_REFUSALS = [{ code: 'SCHEMA_DRIFT', rule: 'the installed board guards and complete schema match their stored stamp', next: 'run pullboard inbox from the main checkout; if drift remains, preserve the board and ask the coordinator to inspect its schema' }];

/** @type {Move[]} */
export const MOVES = [
  { verb: 'rehomeImport', from: ['open'], to: 'verified', by: ['agent'], refuse: 'REHOME_VERDICT',
    guards: ['joined', 'itemExists', IN_STATE, 'sourceAcceptance', 'atSubmittedCommit', 'notBuilder', 'criterionUnchanged', 'proofNoted'],
    sets: ['item_verified_by', 'item_commit'],
    command: 'pullboard move <item reference> --to <handle>' },
  { verb: 'intake', from: ['open'], to: 'submitted', by: ['agent', 'coordinator'], refuse: 'NOT_CLAIMABLE',
    guards: ['joined', 'itemExists', IN_STATE, 'outsideSubmission'], sets: ['item_built_by', 'item_commit', 'item_frozen_digest'], command: 'pullboard intake <PR> --criterion \"...\" --check \"...\"' },
  {
    verb: 'claim', from: ['open', 'claimed'], to: 'claimed', by: ['agent', 'coordinator'], refuse: 'NOT_CLAIMABLE',
    alsoRefuses: [{ code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' },
      { code: 'ITEM_LEASE_LOST', rule: 'a submit admission renews the same still-live build claim', next: 'claim the item before starting a new submit' }],
    guards: ['joined', 'itemExists', IN_STATE, 'checkProvesSomething', 'barReady', 'itemNotHeld', 'inLane', 'routeAllows', 'dependenciesVerified', 'notHeldByAnother', 'builderFirstRefusal', 'correctionRefrozen', 'laneOpen', 'lineCapacity', 'oneLiveClaim', 'rowsInForce'],
    sets: ['item_owner', 'item_lease_until', 'item_frozen_digest'], command: 'pullboard claim <id>',
  },
  {
    verb: 'release', from: ['open', 'claimed'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    guards: ['joined', 'itemExists', IN_STATE, 'releaseOwnsWork', 'reviewReleaseExplained'], command: 'pullboard release <id>',
  },
  { verb: 'lapse', from: ['claimed'], to: 'open', by: ['clock'], guards: [], when: 'its lease runs out' },
  {
    verb: 'submit', from: ['claimed'], to: 'submitted', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    alsoRefuses: [...BOARD_SHAPE_REFUSALS, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }, ...AGENT_GRANT_REFUSALS, { code: 'LINE_SETTING_RANGE', rule: 'the recorded board line setting has a valid registry value', next: 'restore the recorded board line setting from its ordered event history, then retry submit' },
      { code: 'MERGE_ONLY_PROOF', rule: 'a requested carry matches the recorded conflict return, acceptance and exact gated source', next: 'submit normally for outside review' },
      { code: 'SELF_VERIFY', rule: 'the retained original verifier did not author the merge resubmission', next: 'submit the changed source for outside review' },
      { code: 'SELF_SESSION_VERIFY', rule: 'the retained verifier shares no author parent with the resubmitting builder', next: 'submit for another parent session to review' },
      { code: 'PROOF_REQUIRED', rule: 'a carried acceptance records the actual resolution diff', next: 'submit with the current CLI or get an outside review' }],
    guards: ['joined', 'itemExists', IN_STATE, 'isHolder', 'correctionRefrozen', 'checkProvesSomething', 'barReady', 'criterionUnchanged', 'treeClean', 'nothingUntracked', 'hasCommit', 'withinLane', 'trunkMergeClean', 'trunkInCandidate', 'noUnverifiedStack', 'infraExplained', 'doctrineHolds', 'gateConfigured', 'queuedItemLease', 'gateGreen', 'proofRecorded', 'treeStillDuringGate', 'submissionProofValid', 'childrenDone', 'headIsNew'],
    sets: ['item_built_by', 'item_commit'], command: 'pullboard submit <id>',
  },
  {
    verb: 'submit-merge', from: ['claimed'], to: 'verified', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    alsoRefuses: [...BOARD_SHAPE_REFUSALS, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }, ...AGENT_GRANT_REFUSALS],
    guards: ['joined', 'itemExists', IN_STATE, 'isHolder', 'correctionRefrozen', 'checkProvesSomething', 'barReady', 'criterionUnchanged', 'treeClean', 'nothingUntracked', 'hasCommit', 'withinLane', 'trunkMergeClean', 'trunkInCandidate', 'noUnverifiedStack', 'infraExplained', 'doctrineHolds', 'gateConfigured', 'queuedItemLease', 'gateGreen', 'proofRecorded', 'treeStillDuringGate', 'submissionProofValid', 'childrenDone', 'headIsNew', 'mergeOnlyRecorded', 'atSubmittedCommit', 'notBuilder', 'proofNoted'],
    sets: ['item_built_by', 'item_commit', 'item_verified_by'], command: 'pullboard submit <id>',
    when: 'only an unchanged accepted bar and a proved trunk-only merge; no new reviewer verdict is created',
  },
  {
    verb: 'reserve', from: ['submitted'], to: 'submitted', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    alsoRefuses: [{ code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }],
    guards: ['coordinatorSaysAs', 'joined', 'roadmapReadable', 'itemExists', IN_STATE, 'reviewCooldownElapsed', 'notBuilder', 'routeAllows', 'policyAllows', 'familyAllows', 'reviewFree'],
    sets: ['item_review_by', 'item_review_until'], command: 'pullboard next --verify',
  },
  {
    verb: 'accept', from: ['submitted', 'verified'], to: 'verified', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    guards: ['coordinatorSaysAs', 'joined', 'itemExists', IN_STATE, 'atSubmittedCommit', 'notMerged', 'verdictReviewRecorded', 'reviewTreeCurrent', 'notBuilder', 'routeAllows', 'policyAllows', 'familyAllows', 'reviewFree', 'criterionUnchanged', 'reasonIsMet', 'trunkMergeClean', 'noUnverifiedStack', 'queuedItemLease', 'itemCheckGreen', 'proofRecorded', 'proofNoted'],
    alsoRefuses: [...BOARD_SHAPE_REFUSALS, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }, ...AGENT_GRANT_REFUSALS, { code: 'VERDICT_ENVIRONMENT', rule: 'optional recorded verdict environment contains exact platform, architecture and Node version', next: 'run the frozen check with current Pullboard, then have an independent reviewer record a fresh verdict with its actual executor environment' }, { code: 'LAND_HEADER', rule: 'a displayed merge command carries a landing message that passes its own check', next: 'shout the coordinator the item id; landing writes the message, so the item itself needs no change' }, { code: 'ENGINE_VERSION', rule: 'a verdict that implies items replays only under engine 20 or later', next: 'upgrade Pullboard on every linked device before using --implies' }],
    sets: ['item_verified_by'], command: 'pullboard verify <id> accept --note "..."',
  },
  {
    verb: 'reject', from: ['submitted', 'verified'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    guards: ['coordinatorSaysAs', 'joined', 'itemExists', IN_STATE, 'atSubmittedCommit', 'notMerged', 'verdictReviewRecorded', 'reviewTreeCurrent', 'notBuilder', 'routeAllows', 'policyAllows', 'familyAllows', 'reviewFree', 'criterionUnchanged', 'reasonCoded', 'noteGiven', 'causeWellFormed'],
    alsoRefuses: [...BOARD_SHAPE_REFUSALS, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }, ...AGENT_GRANT_REFUSALS, { code: 'VERDICT_ENVIRONMENT', rule: 'optional recorded verdict environment contains exact platform, architecture and Node version', next: 'run the frozen check with current Pullboard, then have an independent reviewer record a fresh verdict with its actual executor environment' }, { code: 'LAND_HEADER', rule: 'a displayed merge command carries a landing message that passes its own check', next: 'shout the coordinator the item id; landing writes the message, so the item itself needs no change' }, { code: 'ENGINE_VERSION', rule: 'a verdict that implies items replays only under engine 20 or later', next: 'upgrade Pullboard on every linked device before using --implies' }, { code: 'NOT_YOURS', rule: 'the automatic escalation is authorized as the coordinator or item holder', next: 'ask the coordinator to inspect the item and its route' }, { code: 'CLOSED', rule: 'the rejected item remains open or claimed when automatic escalation starts', next: 'pullboard show <id>, then ask the coordinator to inspect its current state' }],
    command: 'pullboard verify <id> reject --reason CODE --note "..."',
  },
  {
    verb: 'reopen', from: ['submitted', 'verified'], to: 'open', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED',
    guards: ['joined', 'itemExists', IN_STATE, 'reopenAuthority', 'noteGiven', 'causeWellFormed', 'notMerged', 'landingFailureRecorded', 'trunkConflicts', 'conflictAccepted'],
    alsoRefuses: [{ code: 'BAD_VERDICT_WITHDRAW', rule: 'the explicit withdrawal flag is boolean and is not combined with a conflict', next: 'use --withdraw-verdict with --note only, or report a conflict separately' }, { code: 'ENGINE_VERSION', rule: 'the withdrawal move is replayed by an engine defining its meaning', next: 'update Pullboard before withdrawing a verdict' }, { code: 'BAD_CONFIG', rule: 'the configured first-refusal duration fits a valid UTC deadline', next: 'set claim.reopenFirstRefusalMinutes to a non-negative whole number within the supported date range, or 0 to disable' }],
    sets: ['item_verdict', 'item_verified_by', 'item_owner', 'item_lease_until', 'item_review_by', 'item_review_until'],
    command: 'pullboard reopen <id> [--withdraw-verdict] --note "why" | --conflict <file> [--conflict <file>]',
  },
  {
    verb: 'escalate', from: ['open', 'claimed'], to: 'open', by: ['agent', 'coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'noteGiven', 'itemExists', 'holderOrCoordinator', IN_STATE], command: 'pullboard escalate <id> --note "..."',
  },
  {
    verb: 'refreeze', from: ['open', 'claimed', 'submitted'], to: 'open', by: ['coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'coordinatorOnly', 'itemExists', IN_STATE, 'barReady', 'rowsInForce'],
    when: 'there is no live claim awaiting a coordinator correction',
    sets: ['item_frozen_digest'], command: 'pullboard refreeze <id>',
  },
  {
    verb: 'refreeze', from: ['claimed'], to: 'claimed', by: ['agent', 'coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'itemExists', 'holderOrCoordinator', IN_STATE, 'barReady', 'rowsInForce'],
    when: 'a live claim has a pending coordinator correction',
    sets: ['item_frozen', 'item_frozen_digest'], command: 'pullboard refreeze <id>',
  },
  {
    verb: 'withdraw', from: ['open', 'claimed', 'submitted'], to: 'withdrawn', by: ['coordinator'], refuse: 'CLOSED',
    guards: ['joined', 'coordinatorOnly', 'noteGiven', 'itemExists', IN_STATE],
    sets: ['item_withdrawn_reason'], command: 'pullboard withdraw <id> <reason>',
  },
];

/**
 * Guards shared by every move into a target state, whatever the command (M2). The interpreter adds
 * any a move leaves out, and `machineProblems` reports the move anyway: a guard nobody can see in
 * a move's list is a guard nobody reviews.
 *
 * @type {Record<string, string[]>}
 */
export const EXIT_GUARDS = {
  verified: ['atSubmittedCommit', 'notBuilder', 'criterionUnchanged', 'proofNoted'],
  withdrawn: ['coordinatorOnly', 'noteGiven'],
};

/** The refusal for a move nobody declared, such as a verdict that is neither accept nor reject. */
export const UNKNOWN_MOVE = { refuse: 'BAD_DECISION', rule: 'a verdict is accept or reject', next: 'pullboard verify <id> accept, or reject --reason CODE --note "..."' };

/** @type {Machine} */
export const MACHINE = { roles: ROLES, initial: INITIAL, records: RECORDS, states: STATES, guards: GUARDS, moves: MOVES, exitGuards: EXIT_GUARDS, unknownMove: UNKNOWN_MOVE };

/**
 * The guards a move passes, in order: its own, then any exit guard of its target it left out.
 *
 * @param {Move} move
 * @param {Machine} [machine]
 * @returns {string[]}
 */
export function effectiveGuards(move, machine = MACHINE) {
  const exit = machine.exitGuards[move.to] ?? [];
  return [...move.guards, ...exit.filter((id) => !move.guards.includes(id))];
}

/**
 * The states reachable from `start` along `edges`.
 *
 * @param {string} start
 * @param {Map<string, string[]>} edges
 * @returns {Set<string>}
 */
function reach(start, edges) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of edges.get(/** @type {string} */ (queue.shift())) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Property 1: every state, guard and role a move names is declared.
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function unresolved(machine) {
  const states = new Set(machine.states.map((state) => state.id));
  const guards = new Set(machine.guards.map((guard) => guard.id));
  const problems = [];
  for (const move of machine.moves) {
    for (const state of [...move.from, move.to]) if (!states.has(state)) problems.push(`${move.verb}: no state "${state}"`);
    for (const id of move.guards) if (!guards.has(id)) problems.push(`${move.verb}: no guard "${id}"`);
    for (const role of move.by) if (!machine.roles.includes(role)) problems.push(`${move.verb}: no role "${role}"`);
  }
  for (const [state, ids] of Object.entries(machine.exitGuards)) {
    if (!states.has(state)) problems.push(`exit guards for an undeclared state "${state}"`);
    for (const id of ids) if (!guards.has(id)) problems.push(`exit guards of ${state}: no guard "${id}"`);
  }
  return problems;
}

/**
 * Property 2: every state is reachable from where items start, every non-final state can still
 * reach a final one (no traps), and nothing leaves a final state.
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function unreachable(machine) {
  const forward = new Map();
  const back = new Map();
  for (const move of machine.moves) {
    for (const from of move.from) {
      forward.set(from, [...(forward.get(from) ?? []), move.to]);
      back.set(move.to, [...(back.get(move.to) ?? []), from]);
    }
  }
  const fromStart = reach(machine.initial, forward);
  const canEnd = new Set();
  for (const state of machine.states.filter((entry) => entry.final)) for (const id of reach(state.id, back)) canEnd.add(id);
  const problems = [];
  for (const state of machine.states) {
    if (!fromStart.has(state.id)) problems.push(`state ${state.id} cannot be reached from ${machine.initial}`);
    if (!canEnd.has(state.id)) problems.push(`state ${state.id} is a trap: no way from it to a final state`);
    if (state.final && forward.has(state.id)) problems.push(`final state ${state.id} has a move out`);
  }
  return problems;
}

/**
 * Properties 3 and 4: every final state has exit guards, and every guarded target requires all
 * moves into it to name those guards.
 * A move that leaves one out is a second door (M2).
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function secondDoors(machine) {
  const problems = [];
  for (const state of machine.states.filter((entry) => entry.final)) {
    if (!(machine.exitGuards[state.id] ?? []).length) problems.push(`final state ${state.id} has no exit guards`);
  }
  for (const move of machine.moves) {
    for (const id of machine.exitGuards[move.to] ?? []) {
      if (!move.guards.includes(id)) problems.push(`${move.verb} reaches ${move.to} without naming its exit guard ${id}: a second door`);
    }
  }
  return problems;
}

/**
 * Property 5: every guard has a code, a rule and a next step, and some move uses it; every move
 * a caller makes checks the item's state exactly once and has a code for it (P4).
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function unnamedRefusals(machine) {
  const used = new Set([...machine.moves.flatMap((move) => move.guards), ...Object.values(machine.exitGuards).flat()]);
  const problems = [];
  for (const guard of machine.guards) {
    const codes = [guard.refuse, ...(guard.alsoRefuses ?? []).map((entry) => entry.code)];
    if (guard.id !== IN_STATE && codes.some((code) => !/^[A-Z][A-Z0-9_]*$/.test(code))) problems.push(`guard ${guard.id} names no refusal code`);
    if (!guard.rule.trim()) problems.push(`guard ${guard.id} states no rule`);
    if (!guard.next.trim()) problems.push(`guard ${guard.id} refuses without a next step`);
    for (const refusal of guard.alsoRefuses ?? []) {
      if (!refusal.next?.trim()) problems.push(`guard ${guard.id} refusal ${refusal.code} has no next step`);
    }
    if (!used.has(guard.id)) problems.push(`guard ${guard.id} is declared but no move uses it`);
  }
  for (const move of machine.moves.filter((entry) => !entry.by.includes('clock'))) {
    const checks = move.guards.filter((id) => id === IN_STATE).length;
    if (checks !== 1) problems.push(`${move.verb} checks the item's state ${checks} times, not once`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(move.refuse ?? '')) problems.push(`${move.verb} names no code for an item in the wrong state`);
    for (const refusal of move.alsoRefuses ?? []) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(refusal.code ?? '') || !refusal.rule?.trim() || !refusal.next?.trim()) {
        problems.push(`${move.verb} supplemental refusal has no code, rule or next step`);
      }
    }
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(machine.unknownMove.refuse) || !machine.unknownMove.next.trim()) problems.push('the unknown-move refusal has no code or no next step');
  return problems;
}

/**
 * Property 6: who may make a move agrees with its guards. The coordinator's moves name
 * coordinatorOnly, and only they do; the clock's move is the clock's alone and checks nothing a
 * caller could supply.
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function roleMismatches(machine) {
  const problems = [];
  for (const move of machine.moves) {
    const coordinatorOnly = move.by.length === 1 && move.by[0] === 'coordinator';
    if (coordinatorOnly !== move.guards.includes('coordinatorOnly')) {
      problems.push(`${move.verb} is for ${move.by.join(' or ')}, but its guards ${coordinatorOnly ? 'do not name' : 'name'} coordinatorOnly`);
    }
    if (move.by.includes('clock') && (move.by.length !== 1 || move.guards.length)) {
      problems.push(`${move.verb} mixes the clock with callers or guards a caller could supply`);
    }
  }
  return problems;
}

/**
 * Property 7: every move sets each field its target state requires, or comes from states that
 * already require it.
 *
 * @param {Machine} machine
 * @returns {string[]}
 */
function missingFields(machine) {
  const requires = new Map(machine.states.map((state) => [state.id, state.requires]));
  const problems = [];
  for (const move of machine.moves) {
    for (const from of move.from) {
      const carried = new Set([...(requires.get(from) ?? []), ...(move.sets ?? [])]);
      for (const field of requires.get(move.to) ?? []) {
        if (!carried.has(field)) problems.push(`${move.verb} from ${from} can reach ${move.to} without ${field}`);
      }
    }
  }
  return problems;
}

/**
 * Every property the declaration breaks (M4); empty when it is sound.
 *
 * @param {Machine} [machine]
 * @returns {string[]}
 */
export function machineProblems(machine = MACHINE) {
  return [
    ...unresolved(machine),
    ...unreachable(machine),
    ...secondDoors(machine),
    ...unnamedRefusals(machine),
    ...roleMismatches(machine),
    ...missingFields(machine),
  ];
}

/**
 * Text as an SQL string literal.
 *
 * @param {string} text
 * @returns {string}
 */
const sqlText = (text) => `'${text.replaceAll("'", "''")}'`;

/**
 * The characters JavaScript's trim removes, as code points. A field made only of them is blank in
 * the board file, exactly as it is to the commands that trim what an agent typed.
 */
export const BLANKS = [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279];

/**
 * The SQLite triggers that make the board file itself refuse what the declaration does not allow
 * (M3): an item that starts anywhere but the start, a state or a move nobody declared, an item left
 * in a state without that state's fields or proof, and an edit to a record the board keeps for good.
 * A state's fields and proof are checked on every write that leaves an item in it, a move in or an
 * edit while it stays, so no field that makes the proof can be rewritten after it. All of it comes
 * from the declaration, so the board reinstalls any trigger that differs when the declaration changes.
 *
 * The triggers stop a status written by hand. They cannot stop an agent that forges a verdict row
 * under some name and then moves the item; that forgery stays in the ledger under the name it used.
 *
 * @param {Machine} [machine]
 * @returns {{ name: string, sql: string }[]}
 */
export function storeTriggers(machine = MACHINE) {
  const refuse = (code, text) => `BEGIN SELECT RAISE(ABORT, ${sqlText(`${code}: ${text}; the board changes only through pullboard commands`)}); END`;
  const onStatus = 'BEFORE UPDATE OF item_status ON item';
  const states = machine.states.map((state) => state.id);
  const moves = [...new Set(machine.moves.flatMap((move) => move.from.filter((from) => from !== move.to).map((from) => `${from}>${move.to}`)))];
  const declared = `OLD.item_status || '>' || NEW.item_status IN (${moves.map(sqlText).join(', ')})`;
  const holds = (state) => `NEW.item_status = ${sqlText(state)} AND (OLD.item_status = NEW.item_status OR ${declared})`;
  const onWrite = 'BEFORE UPDATE ON item';
  const trigger = (name, on, body) => ({ name, sql: `CREATE TRIGGER ${name} ${on}\n${body}` });
  // Each write meets at most one trigger: an unknown state, else an undeclared move, else missing
  // fields, else a missing proof. SQLite fires triggers in no promised order, so their conditions
  // exclude each other and the refusal never depends on which one ran first. A blank field is one
  // that BLANKS trims to nothing.
  const triggers = [
    trigger('machine_item_start', 'BEFORE INSERT ON item', `WHEN NEW.item_status <> ${sqlText(machine.initial)}\n${refuse('UNDECLARED_MOVE', `an item starts ${machine.initial}`)}`),
    trigger('machine_item_state', onStatus, `WHEN NEW.item_status NOT IN (${states.map(sqlText).join(', ')})\n${refuse('UNDECLARED_STATE', `an item is ${states.join(', ')}`)}`),
    trigger(
      'machine_item_move',
      onStatus,
      `WHEN NEW.item_status IN (${states.map(sqlText).join(', ')}) AND OLD.item_status <> NEW.item_status AND NOT ${declared}\n${refuse('UNDECLARED_MOVE', `the moves are ${moves.join(', ')}`)}`,
    ),
  ];
  const blank = `char(${BLANKS.join(', ')})`;
  const missingOf = (state) => state.requires.map((field) => `trim(coalesce(NEW.${field}, ''), ${blank}) = ''`).join(' OR ');
  for (const state of machine.states.filter((entry) => entry.requires.length)) {
    triggers.push(trigger(`machine_fields_${state.id}`, onWrite, `WHEN ${holds(state.id)} AND (${missingOf(state)})\n${refuse('MISSING_FIELD', `${state.id} needs ${state.requires.join(', ')}`)}`));
  }
  for (const state of machine.states.filter((entry) => entry.proof)) {
    const complete = state.requires.length ? ` AND NOT (${missingOf(state)})` : '';
    triggers.push(trigger(`machine_proof_${state.id}`, onWrite, `WHEN ${holds(state.id)}${complete} AND NOT (${state.proof.sql})\n${refuse('NOT_PROVEN', `${state.id} needs ${state.proof.says}`)}`));
  }
  for (const [table, kept] of Object.entries(machine.records)) {
    for (const change of kept === 'append' ? ['update', 'delete'] : ['delete']) {
      const text = kept === 'append' ? `${table} rows are only ever added` : `an ${table} is withdrawn, never deleted`;
      triggers.push(trigger(`machine_${table}_${change}`, `BEFORE ${change.toUpperCase()} ON ${table}`, refuse(kept === 'append' ? 'APPEND_ONLY' : 'KEPT', text)));
    }
  }
  return triggers;
}

/**
 * A guard as the lifecycle page shows it: its id, with the code it raises, or the move's own code
 * for the state check.
 *
 * @param {Machine} machine
 * @param {Move} move
 * @param {string} id
 * @returns {string}
 */
function guardLabel(machine, move, id) {
  const guard = machine.guards.find((entry) => entry.id === id);
  const codes = id === IN_STATE ? [move.refuse] : [guard?.refuse, ...(guard?.alsoRefuses ?? []).map((entry) => entry.code)];
  const declared = codes.filter(Boolean).join(' or ');
  return declared ? `${id} (${declared})` : id;
}

/**
 * The lifecycle as a markdown page: a Mermaid state diagram, every move with its guards in the
 * order they are checked (transition guards included), each guarded target's required guards, and every refusal
 * with the rule behind it and the next step (M1, P4). docs/lifecycle.md is this page, written by
 * `pullboard lifecycle`, and a test fails when the two differ, so the page cannot drift from the code.
 *
 * @param {Machine} [machine]
 * @returns {string}
 */
export function lifecycleMarkdown(machine = MACHINE) {
  const cell = (text) => String(text).replaceAll('|', '\\|');
  const finals = machine.states.filter((state) => state.final);
  const transitionGuards = Object.entries(machine.exitGuards);
  const edges = machine.moves.flatMap((move) => move.from.map((from) => `  ${from} --> ${move.to}: ${move.verb}${move.by.includes('clock') ? ' (clock)' : ''}`));
  const moves = machine.moves.map((move) => {
    const who = move.when ? `${move.by.join(', ')}, when ${move.when}` : move.by.join(', ');
    const guards = effectiveGuards(move, machine).map((id) => guardLabel(machine, move, id));
    const resultRefusals = (move.alsoRefuses ?? []).map(({ code }) => `result (${code})`);
    const checks = [...guards, ...resultRefusals].join(', ') || 'none';
    return `| ${move.verb} | ${move.from.join(', ')} | ${move.to} | ${cell(who)} | ${cell(checks)} |`;
  });
  const wrongState = machine.moves.filter((move) => move.refuse).map((move) => `| ${move.refuse} | ${move.verb}: the item is in ${move.from.join(', ')} | pullboard show <id> |`);
  const refusals = machine.guards.filter((guard) => guard.id !== IN_STATE).flatMap((guard) => [
    { code: guard.refuse, next: guard.next },
    ...(guard.alsoRefuses ?? []),
  ].map(({ code, next }) => `| ${code} | ${cell(guard.when ? `${guard.rule}, ${guard.when}` : guard.rule)} | ${cell(next)} |`));
  const resultRefusals = machine.moves.flatMap((move) => (move.alsoRefuses ?? []).map(({ code, rule, next }) => `| ${code} | ${cell(rule)} (${move.verb} result) | ${cell(next)} |`));
  const unknown = `| ${machine.unknownMove.refuse} | ${cell(machine.unknownMove.rule)} | ${cell(machine.unknownMove.next)} |`;
  return [
    '# The item lifecycle',
    '',
    'Generated from src/machine.js by `pullboard lifecycle`. Do not edit it by hand: change the declaration, then run `pullboard lifecycle > docs/lifecycle.md`.',
    '',
    `An item starts ${machine.initial}. Its final states, ${finals.map((state) => state.id).join(' and ')}, cannot be left. Every move into a guarded state passes the same transition guards, whatever command gets there. The board file itself refuses any move not declared here.`,
    '',
    '## Frozen check policy',
    '',
    'The coordinator may set `check.install` and `check.timeout` in committed `pullboard.json`; the defaults are no install command and `5m`. Accept runs the configured install and the frozen item check in a private clone, under one timeout budget. It reuses the verifier’s npm cache when available. Install commands that need network downloads conflict with P2 (offline); configure an offline install or make its needed packages available in the cache.',
    '',
    "Private commands drain their output through pipes, retaining a bounded 8 MiB capture of its beginning and end. Failed or unverifiable checks stream the complete log through secret scanning into an owner-readable artifact; lines over 64 KiB of UTF-8 data are replaced with a safe-scan marker. Output beyond the capture cap does not fail a successful command, and dependency files and build artifacts have no capture-size limit. A timeout kills the command's process group. An unverified check names how to restore the environment and retry; a failing check names rejection or builder rework as the next step.",
    '',
    '```mermaid',
    'stateDiagram-v2',
    `  [*] --> ${machine.initial}`,
    ...[...new Set(edges)],
    ...finals.map((state) => `  ${state.id} --> [*]`),
    '```',
    '',
    '## States',
    '',
    '| State | Means | Fields it needs |',
    '| --- | --- | --- |',
    ...machine.states.map((state) => `| ${state.id}${state.final ? ' (final)' : ''} | ${cell(state.means)} | ${state.requires.join(', ') || 'none'} |`),
    '',
    '## Moves',
    '',
    'Each move checks its guards in this order and refuses with the first one that does not hold; result-path refusals are listed separately.',
    '',
    '| Move | From | To | Who | Guards, in order; result refusals |',
    '| --- | --- | --- | --- | --- |',
    ...moves,
    '',
    '## Required transition guards',
    '',
    '| State entered | Every move into it passes |',
    '| --- | --- |',
    ...transitionGuards.map(([state, guards]) => `| ${state} | ${guards.join(', ')} |`),
    '',
    '## Refusals',
    '',
    '| Code | Raised when this does not hold | Next step |',
    '| --- | --- | --- |',
    ...[...new Set([...wrongState, ...refusals, ...resultRefusals, unknown])],
    '',
    'For check diagnostics, a refusal from a failed or unverifiable check includes an output digest, sanitized tail, and a private full-output path in the CLI message (also `error.message` in JSON). The artifact is owner-readable only. If it cannot be saved, the tail remains available and the message names the storage error instead of claiming a path.',
    '',
  ].join('\n');
}

/**
 * The help screen's lifecycle section: who may make which moves, read from the declaration.
 *
 * @param {Machine} [machine]
 * @returns {string}
 */
export function lifecycleHelp(machine = MACHINE) {
  const lines = machine.roles.map((role) => {
    const moves = machine.moves.filter((move) => move.by.includes(role));
    const counts = new Map();
    for (const move of moves) counts.set(move.verb, (counts.get(move.verb) ?? 0) + 1);
    const when = moves.filter((move) => move.when && counts.get(move.verb) === 1).map((move) => `${move.verb} (when ${move.when})`);
    const plain = [...new Set(moves.filter((move) => !move.when || counts.get(move.verb) > 1).map((move) => move.verb))];
    return `  ${role.padEnd(13)} ${[...plain, ...when].join(', ')}`;
  });
  return ['Lifecycle, read from src/machine.js', '  pullboard lifecycle         the states, moves, guards and refusals as a markdown page, with a diagram', ...lines].join('\n');
}
