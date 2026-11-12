/** The item lifecycle declaration as pure data, shared by core readers without loading the shell machine [M1,C7]. */
import { IN_STATE } from './shared.js';
export { IN_STATE };

import { MOVES as patchMoves } from './move/patch.js';
import { MOVES as rehomeImportMoves } from './move/rehome.js';
import { MOVES as intakeMoves } from './move/intake.js';
import { MOVES as claimMoves } from './move/claim.js';
import { MOVES as releaseMoves } from './move/release.js';
import { MOVES as lapseMoves } from './move/lapse.js';
import { MOVES as submitMoves } from './move/submit.js';
import { MOVES as submitMergeMoves } from './move/submit/merge.js';
import { MOVES as reserveMoves } from './move/reserve.js';
import { MOVES as acceptMoves } from './move/accept.js';
import { MOVES as rejectMoves } from './move/reject.js';
import { MOVES as reopenMoves } from './move/reopen.js';
import { MOVES as escalateMoves } from './move/escalate.js';
import { MOVES as refreezeMoves } from './move/refreeze.js';
import { MOVES as withdrawMoves } from './move/withdraw.js';

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
  { id: 'clausesInspected', refuse: 'CLAUSE_UNTICKED', rule: 'an explicitly inspected submit carries matching holder evidence for each declared criterion clause', next: 'tick each named clause with its declared evidence kind, then submit again', source: 'board' },
  { id: 'sourceAcceptance', refuse: 'REHOME_VERDICT', rule: 'the authenticated destination mover attests to an exact source board ACCEPT reference keyed by the ordered source MOVEID and result digest', next: 'preserve the imported source acceptance attribution, frozen digest, commit and verifier reference', source: 'board' },
  { id: 'mergeOnlyRecorded', refuse: 'MERGE_ONLY_PROOF', rule: 'the sealed submit records the origin’s Git-derived carry, unchanged bar and original verifier; landing re-proves its heads, trees and resolution hash before merging', next: 'submit normally for outside review if the origin cannot prove the merge', source: 'board' },
  { id: 'specRefreezeAllowed', refuse: 'CLOSED', rule: 'an unmerged acceptance is refrozen only within a validated cited-spec correction', next: 'apply the person-approved cited spec correction, or reopen through the normal review workflow', source: 'board' },
  { id: 'outsideSubmission', refuse: 'OUTSIDE_SOURCE', rule: 'an outside author and exact fetched commit/tree are recorded with a trusted frozen criterion, without pretending a native builder gated it', next: 'fetch and intake the exact GitHub pull request again', source: 'board' },
  { id: IN_STATE, refuse: '', rule: "the move can start from the item's current state", next: 'pullboard show <id>', source: 'board' },
  { id: 'joined', refuse: 'NOT_JOINED', alsoRefuses: [{ code: 'POLICY_SNAPSHOT_STALE', rule: 'prepared accepted policy remains current through a CLI board write; a stale transaction rolls back without replaying its callback', next: 'retry the original command from the top against current accepted main; its stale database transaction was rolled back' }, { code: 'AGENT_REPLACED', next: 'read the takeover and only shout on its exact hand-off item; continue work from the incoming agent worktree' }, { code: 'SESSION_LEDGER', next: 'make the agent-session ledger named in the message readable and writable by this user, then run the command again' }], rule: 'the caller is the main checkout, or an unreplaced worktree seat that joined a lane; an agent session\'s claims, submits and verdicts can be checked against its local ledger', next: 'pullboard join <lane> --model "<model name>" (see: pullboard lanes)', source: 'cli' },
  { id: 'itemExists', refuse: 'NO_ITEM', alsoRefuses: [{ code: 'ITEM_MOVED', next: 'use the recorded destination reference shown in the refusal; do not move the old ID again' }], rule: 'the item exists and has not been moved', next: 'pullboard list --all', source: 'board' },
  { id: 'patchObjection', refuse: 'ITEM_PATCH_WINDOW', rule: 'a registered owner in the companion patch lane objects before the recorded review deadline', next: 'read pullboard patch list <id>; only the named lane owner may object during its window', source: 'board' },
  { id: 'gateReceipt', refuse: 'GATE_PENDING', rule: 'the submitted head has a captured gate proof receipt before it is reserved or given a verdict', next: 'pullboard next --verify, which offers the item once its gate result and receipt exist', source: 'board' },
  { id: 'companionWindow', refuse: 'COMPANION_WINDOW', rule: 'the automatic companion objection window has elapsed before review is reserved', next: 'wait for the owner objection window to end, or ask the owning lane to object', source: 'board' },
  { id: 'reopenAuthority', refuse: 'COORDINATOR_ONLY', rule: 'the coordinator reopens, the native board computes an automatic submitted-head conflict, or the exact accepting reviewer withdraws its verdict; older recorded submitted-conflict moves keep their joined-seat authority', next: 'ask the coordinator or the reviewer who recorded the accept', source: 'board', alsoRefuses: [{ code: 'NO_POLICY', next: 'restore the local Git configuration so the current trunk can be read, then compute a fresh automatic return' }, { code: 'GIT_GRAFTS', next: 'ask the coordinator to remove the replica graft file, then resume the same move' }, { code: 'GIT_REPLACE_REFS', next: 'ask the coordinator to remove the replica replacement refs, then resume the same move' }, { code: 'VERDICT_WITHDRAW_FORBIDDEN', next: 'ask the accepting reviewer or coordinator to withdraw the verdict' }, { code: 'VERDICT_WITHDRAW_STATE', next: 'refresh the item; only a current acceptance before landing can be withdrawn' }, { code: 'REVIEW_HELD', next: 'take another review: pullboard next --verify' }] },
  { id: 'coordinatorOnly', refuse: 'COORDINATOR_ONLY', rule: 'the caller is the coordinator', next: 'run it from the main checkout', source: 'board' },
  { id: 'roadmapReadable', refuse: 'MILESTONES_CORRUPT', alsoRefuses: [{ code: 'LINE_SETTING_RANGE', rule: 'the recorded board line-order setting has a valid registry value', next: 'restore the recorded board line setting from its ordered event history, then retry next --verify' }], rule: 'the recorded queue policy and roadmap are readable when selecting the next review', next: 'restore board metadata from a known-good board export', source: 'board', when: 'only next --verify selection; a review reserved by id does not consult the roadmap' },
  { id: 'coordinatorSaysAs', refuse: 'MAIN_IS_COORDINATOR', rule: 'in the main checkout, the caller says it is the coordinator', next: 'verify from your own worktree; the coordinator adds --as coordinator', source: 'cli' },
  { id: 'holderOrCoordinator', refuse: 'NOT_YOURS', rule: 'the caller holds the item, or is the coordinator', next: 'shout its holder, or the coordinator', source: 'board' },
  { id: 'releaseOwnsWork', refuse: 'NOT_YOURS', alsoRefuses: [{ code: 'RELEASE_REASON', rule: 'a release names a reason code from INELIGIBLE, ROUTED_ELSEWHERE, BLOCKED, BUDGET, TAKEN_OVER or OTHER; OTHER carries its text in the note', next: 'release with --reason <code>' }, { code: 'BAD_CONFIG', rule: 'captured stale-claim health.stuck and health.holds durations use the supported duration grammar', next: 'fix pullboard.json as the message says, then commit it: git commit -m \"chore: fix pullboard config\" pullboard.json' }, { code: 'ENGINE_VERSION', rule: 'gone-seat and stale claim releases replay only under engines defining their frozen coordinator observations', next: 'upgrade Pullboard on every linked device before using automatic or stale claim release' }], rule: 'the caller holds the claim, yields its own first-refusal window, or is the coordinator recording a complete gone-seat or stale-claim observation', next: 'release your own claim or reservation, or ask the current builder', source: 'board' },
  { id: 'isHolder', alsoRefuses: [{ code: 'OUTSIDE_NATIVE_BUILD', next: 'the outside author revises the PR; ask the coordinator to return it, then intake the new exact head' }], refuse: 'NOT_YOURS', rule: 'the caller holds the claim', next: 'pullboard claim <id>', source: 'board' },
  { id: 'inLane', alsoRefuses: [{ code: 'OUTSIDE_NATIVE_BUILD', next: 'the outside author revises the PR; ask the coordinator to return it, then intake the new exact head' }], refuse: 'WRONG_LANE', rule: "the item is in the caller's lane; the main checkout builds coordinator-lane items only", next: "cd <the lane's worktree> && pullboard claim <id>", source: 'board' },
  { id: 'routeAllows', alsoRefuses: [{ code: 'DIAGNOSIS_REQUIRED', next: 'have a mid or strong seat record Files, Change and Test case with pullboard fact <id> diagnosis before a light seat claims it' }], refuse: 'ROUTE', rule: "the caller's route covers the item's: light, then mid, then strong", next: 'pullboard next, which offers only items your route covers', source: 'board' },
  { id: 'buildScopeFits', refuse: 'ITEM_BUILD_BUDGET', alsoRefuses: [{ code: 'BAD_BUILD_BUDGET', next: 'restore a positive itemBuildBudgetMinutes setting, then retry' }], rule: 'known expected build minutes fit the captured board budget before a new claim', next: 'cut the item into a parent and children whose expected minutes fit the budget; claim a child', source: 'board' },
  { id: 'dependenciesVerified', refuse: 'BLOCKED', rule: 'every item it waits on is verified', next: 'claim another item, or shout the lane it waits on', source: 'board' },
  { id: 'builderFirstRefusal', refuse: 'REOPEN_HELD_FOR_BUILDER', rule: 'a returned item waits for its original builder until its recorded deadline or builder release', next: 'wait until the named deadline, or ask its builder to run pullboard release <id>', source: 'board' },
  { id: 'notHeldByAnother', refuse: 'HELD', rule: 'no other agent holds it under a live lease', next: 'pullboard next', source: 'board' },
  { id: 'laneOpen', refuse: 'LANE_HELD', rule: 'nobody holds its lane', next: 'pullboard next --wait 9 (minutes)', source: 'board', when: 'unless the caller is renewing its own live claim' },
  { id: 'itemNotHeld', refuse: 'ITEM_HELD', rule: 'the coordinator has not put this item on hold', next: 'the coordinator lifts it with pullboard hold <id> --off', source: 'board', when: 'unless the caller is renewing its own live claim' },
  { id: 'correctionRefrozen', refuse: 'PENDING_REFREEZE', rule: 'no coordinator correction to a claimed criterion or check is waiting to be frozen', next: 'pullboard refreeze <id>', source: 'board' },
  { id: 'lineCapacity', refuse: 'LINE_WIP_LIMIT', alsoRefuses: [{ code: 'LINE_SETTING_RANGE', next: 'restore the malformed recorded line setting before claiming' }], rule: 'a new claim stays within recorded WIP per active reviewer', next: 'review the oldest eligible waiting submission: pullboard next --verify', source: 'board', when: 'only for new claims while wipPerReviewer is on' },
  { id: 'oneLiveClaim', refuse: 'ONE_CLAIM', rule: 'the caller holds no other live top-level claim, reworks of its own rejected items aside', next: 'submit or release the other item first; child items are free', source: 'board' },
  { id: 'rowsInForce', refuse: 'UNKNOWN_SPEC', alsoRefuses: [{ code: 'A5_GRAMMAR_VERSION', next: 'upgrade Pullboard or use a file written for grammar 1' }, { code: 'NO_POLICY', next: 'restore the committed coordinator policy' }, { code: 'BAD_CONFIG', next: 'repair and commit the coordinator configuration' }, { code: 'AGENT_APPROVAL_REQUIRED', next: 'ask the coordinator to arrange the person’s confirmation or decline, or change the explicit refuse setting' }, { code: 'BAR_NOT_READY', next: 'another parent session signs coverage for the current accepted test inventory and runner' }], rule: 'every row the item cites exists and is in force', next: 'fix the spec, or the coordinator withdraws the item', source: 'board', when: 'only where the criterion freezes: claiming an item with no frozen criterion, and refreeze' },
  { id: 'criterionUnchanged', refuse: 'CRITERIA_CHANGED', alsoRefuses: [{ code: 'ITEM_PATCH_CHANGED', next: 'compose the current patch set and rerun review' }, { code: 'ITEM_PATCH_SOURCE', next: 'replace stale patches against the current submitted source' }, { code: 'ITEM_PATCH', next: 'replace the unsafe or conflicting patch with a source-bound correction' }, { code: 'ITEM_PATCH_AUTHOR', next: 'restore the native author before reviewing the patch' }], rule: 'the criterion and the rows it cites read as they did at claim', next: 'the coordinator runs pullboard refreeze <id>', source: 'cli' },
  { id: 'treeClean', refuse: 'DIRTY', rule: 'the worktree has no uncommitted changes', next: 'commit your changes, then submit', source: 'cli' },
  { id: 'sourcePlaced', refuse: 'CELLS_PLAN_UNPLACED', rule: 'when accepted main carries the cells plan, every in-scope committed source path has a placement', next: 'run node packages/codemap/src/io/cells/scripts/plan.js --place <path> --cell <cell> (or --stay), commit the source and plan, then submit', source: 'cli' },
  { id: 'nothingUntracked', refuse: 'UNTRACKED', alsoRefuses: [{ code: 'WRONG_BRANCH', rule: "the head's new commits name this item, not another", next: 'submit the item the commits name, or switch to the branch built for this item' }, { code: 'LANE_CHECK_FOREIGN', rule: 'an item check file belongs to the item lane', next: 'point the check at a file in your own lane' }], rule: 'the worktree has no untracked files', next: 'commit or ignore them, then submit', source: 'cli' },
  { id: 'hasCommit', refuse: 'NO_COMMIT', alsoRefuses: [{ code: 'HOST_NAME', next: 'reword the named commit\'s message without this machine\'s name (git rebase -i, then reword), then run pullboard submit <id> again' }], rule: 'there is a commit to submit, and no commit it adds names this machine', next: 'commit your work, then submit', source: 'cli' },
  { id: 'gateConfigured', refuse: 'NO_GATE', rule: 'the repo names a gate command', next: 'in the main checkout, run pullboard gate set "<project test command>", then commit pullboard.json', source: 'cli' },
  { id: 'withinLane', refuse: 'OUTSIDE_LANE', alsoRefuses: [{ code: 'NO_POLICY', next: 'restore the claim base or ask the coordinator to refreeze' }, { code: 'BAD_CONFIG', next: 'restore the committed coordinator configuration' }, { code: 'GIT_GRAFTS', next: 'ask the coordinator to remove the Git graft file before retrying' }, { code: 'LANE_CHECK_FOREIGN', next: 'shout the owner named in the message to set a check that names that file, or name only your own lane\'s test files' }], rule: 'the full claimed diff respects committed coordinator ownership', next: 'restore foreign paths or shout their owner', source: 'cli' },
  { id: 'trunkMergeClean', refuse: 'MERGE_CONFLICT', alsoRefuses: [{ code: 'MERGE_CHECK_FAILED', next: 'use Git 2.38 or newer, restore its objects and retry' }, { code: 'NO_POLICY', next: 'restore the primary repository metadata' }, { code: 'NO_TRUNK', next: 'check out the trunk branch in the main checkout once and run pullboard inbox' }], rule: 'the candidate merges cleanly into the current primary branch without changing an index or worktree', next: 'merge the trunk into your branch, resolve conflicts, commit and resubmit', source: 'cli' },
  { id: 'trunkInCandidate', refuse: 'MAIN_NOT_COMPOSED', alsoRefuses: [{ code: 'SUBMIT_PIN_NOT_MAIN', next: 'run pullboard submit again so it captures the current main' }], rule: 'the candidate contains the main its submission proof pins; a main that moves during the proof is merged without a rerun only when none of its commits touches a file the item changes, its check runs or its affected tests read', next: 'merge main, commit the composition, then submit again', source: 'cli', when: 'bar ready is enabled for this board' },
  { id: 'noUnverifiedStack', refuse: 'STACKED_ON_UNVERIFIED', alsoRefuses: [{ code: 'WRONG_BRANCH', next: 'submit the item named in the message from this head, or switch to the branch built for this item' }], rule: "the candidate range contains no other item's unverified submitted commit", next: 'wait for that item to be accepted, or rebuild without its commits', source: 'cli' },
  { id: 'doctrineHolds', refuse: 'RATCHET_ROSE', alsoRefuses: [{ code: 'RATCHET_UNCOUNTED', next: 'fix the check so it exits 0 or 1 within its timeout, then submit again' }], rule: "every touched doctrine check counts (exit 0 or 1), none rises above its committed count and no changed file gains a problem; watch-mode rules only count", next: "fix the new problems, commit, submit again; only the person's signature raises count:", source: 'cli', when: 'only when accepted main has an approved doctrine rule with gate: check' },
  { id: 'itemCheckGreen', refuse: 'CHECK_RED', alsoRefuses: [{ code: 'RUNNER_UNAVAILABLE', next: 'inspect the unavailable runner and its exact cleanup generation; restore it before another attempt' }, { code: 'RUNNER_JOB_LOST', next: "inspect the exact runner and job named in the diagnostic; cleanup remains unknown until the pinned worker proves it, then retry" }, { code: 'RUNNER_TOOLING_FILES', rule: 'the worker import closure stays inside package.json files and the existing bounded transfer', next: 'repair package.json files or the named worker import, keeping the runner transfer bound unchanged' }, { code: 'RUNNER_RESULT_INVALID', next: 'inspect the retained transport diagnostic and repair the named protocol or capsule failure before retrying' }, { code: 'RUNNER_RESULT_SIGNATURE', next: 're-register the runner with pullboard runner add before accepting another result' }, { code: 'RUNNER_RESULT_SOURCE', next: 'discard the mismatched result and rerun the pinned source' }, { code: 'RUNNER_WORK_SPEC', next: 'upgrade or repair the controller and runner together, then retry the named invalid work specification' }, { code: 'RUNNER_LIFECYCLE_PROVIDER', next: 'restart with the current installed controller so its canonical item lifecycle observer is composed' }, { code: 'RUNNER_WAIT_DEADLINE', next: 'check the runners the message names, or restore local gate capacity with pullboard settings, then retry' }, { code: 'RUNNER_INFRA_RETRY_EXHAUSTED', next: 'inspect the retained runner diagnostic, restore the named runner, then retry this command' }, { code: 'RUNNER_BROWSER_SLOT_REQUIRED', next: 'nothing to do: the run reruns on a local gate slot; if it repeats, set gate.browserByLaunch the same on this machine and that runner' }, { code: 'RUNNER_GUI_SESSION_REQUIRED', next: 'nothing to do: the run reruns locally; log in to a GUI session on the runner before sending GUI-marked files there' }, { code: 'SANDBOX_PROVIDER_REQUIRED', next: 'configure the committed main Docker provider and pinned minimum/current images' }, { code: 'SANDBOX_IMAGE_REQUIRED', next: 'preload the exact pinned official image into the configured daemon' }, { code: 'SANDBOX_RUNTIME', next: 'correct the pinned image so its actual Node version matches its role' }, { code: 'SANDBOX_EXPORT', next: 'restore access to the exact private Git export and recorded tree' }, { code: 'SANDBOX_EXECUTION', next: 'restore the Docker runtime and inspect the owned container before another verification' }, { code: 'SANDBOX_CLEANUP_REQUIRED', next: 'remove the exact named owned container after restoring Docker' }, { code: 'SANDBOX_CHECK_REQUIRED', next: 'set a trusted full gate and frozen criterion before intake' }, { code: 'CHECK_NO_PROOF', next: 'strengthen the criterion so it fails before the outside change' }, { code: 'OUTSIDE_SANDBOX_REQUIRED', next: 'verify the outside item with --sandbox using the configured container provider' }, { code: 'SLOT_DB_LOCKED', next: 'the run never started, so it is not a red; rerun the same command once the named process releases the slot database' }, { code: 'TIMING_SLOT_REQUIRED', next: 'start the timing check outside its inherited ordinary lease and acquire the machine gate with timing true' }, { code: 'CHECK_UNVERIFIED', next: 'restore the frozen install or check environment and retry' }, { code: 'GUARD_CANNOT_FAIL', next: 'reject: the check stays green with the named guard reverted' }, { code: 'GUARD_NOT_FOUND', next: 'the named guard is not in the submitted commit; ask the coordinator to fix it' }], rule: 'the frozen item check passes at the submitted commit, or its clean reviewed composition for a stale acceptance', next: 'reject the failing behavior; the builder fixes and resubmits', source: 'cli' },

  { id: 'barReady', refuse: 'BAR_NOT_READY', alsoRefuses: [{ code: 'UNDECLARED_BUILDER_FAMILY', rule: 'required-family work has a builder with a native derived family before its claim', next: 'run pullboard join <lane> --family <vendor> --model "<model name>", then claim again' }], rule: 'an opted-in new bar has a named red baseline, measurement notes, reviewer edges and a revision-bound signature from another parent session', next: 'the author completes the brief, then another parent runs pullboard bar sign <id>', source: 'board', when: 'bar ready is on and this bar was frozen or edited after activation' },
  { id: 'checkProvesSomething', refuse: 'CRITERION_PROVES_NOTHING', rule: "the item's check does not already pass on main, or the person accepted that exact check", next: 'set a check that fails before the work, or the person runs pullboard check accept <id>', source: 'cli', when: 'only when accepted main sets checks.provesNothing to "hold"' },
  { id: 'gateGreen', refuse: 'GATE_RED', alsoRefuses: [{ code: 'LAND_RUNNER', next: 'run the landing through its in-process batch runner' }, { code: 'LAND_RUNNER_FAULT', next: 'the landing retries by itself; wait for the next attempt' }, { code: 'PIN_TOOLING_CORRUPT', next: 'delete the unreadable tooling pin file; the next landing rewrites it' }, { code: 'RUNNER_UNAVAILABLE', next: 'inspect the unavailable runner and its exact cleanup generation; restore it before another attempt' }, { code: 'RUNNER_JOB_LOST', next: "inspect the exact runner and job named in the diagnostic; cleanup remains unknown until the pinned worker proves it, then retry" }, { code: 'RUNNER_TOOLING_FILES', rule: 'the worker import closure stays inside package.json files and the existing bounded transfer', next: 'repair package.json files or the named worker import, keeping the runner transfer bound unchanged' }, { code: 'RUNNER_RESULT_INVALID', next: 'inspect the retained transport diagnostic and repair the named protocol or capsule failure before retrying' }, { code: 'RUNNER_RESULT_SIGNATURE', next: 're-register the runner with pullboard runner add before accepting another result' }, { code: 'RUNNER_RESULT_SOURCE', next: 'discard the mismatched result and rerun the pinned source' }, { code: 'RUNNER_WORK_SPEC', next: 'upgrade or repair the controller and runner together, then retry the named invalid work specification' }, { code: 'RUNNER_LIFECYCLE_PROVIDER', next: 'restart with the current installed controller so its canonical item lifecycle observer is composed' }, { code: 'RUNNER_WAIT_DEADLINE', next: 'check the runners the message names, or restore local gate capacity with pullboard settings, then retry' }, { code: 'RUNNER_INFRA_RETRY_EXHAUSTED', next: 'inspect the retained runner diagnostic, restore the named runner, then retry this command' }, { code: 'RUNNER_GUI_SESSION_REQUIRED', next: 'nothing to do: the run reruns locally; log in to a GUI session on the runner before sending GUI-marked files there' }, { code: 'LAND_TIMEOUT_CUSTODY', next: 'inspect the saved timed gate cleanup state and stop only its proven owned processes before starting another landing' }, { code: 'LAND_GATE_OUTPUT', next: 'inspect the retained timed gate output directory and free disk space, then start another landing' }, { code: 'SLOT_DB_LOCKED', next: 'the run never started, so it is not a red; rerun the same command once the named process releases the slot database' }, { code: 'TIMING_SLOT_REQUIRED', next: 'start the timing check outside its inherited ordinary lease and acquire the machine gate with timing true' }, { code: 'RUNNER_BROWSER_SLOT_REQUIRED', next: 'nothing to do: the run reruns on a local gate slot; if it repeats, set gate.browserByLaunch the same on this machine and that runner' }, { code: 'PIPEFAIL_UNAVAILABLE', next: 'rewrite the gate without a pipe' }], rule: 'the item check is green; submission proof is green or every failure matches exact main or a live person waiver', next: 'fix what the digest names, commit, submit again', source: 'cli' },
  { id: 'queuedItemLease', refuse: 'ITEM_LEASE_LOST', alsoRefuses: [{ code: 'A5_GRAMMAR_VERSION', next: 'upgrade Pullboard or restore a spec written for grammar 1, then retry' }, { code: 'NOT_A_REPO', next: 'restore the worktree Git metadata, then retry the command' }, { code: 'NO_CONFIG', next: 'restore pullboard.json in this worktree, then retry the command' }], rule: 'the caller still owns the same live item claim or review and can renew it against the frozen criterion', next: 'claim or reserve the item again before retrying the command', source: 'cli', when: 'while submit or an accept waits for a machine slot, and once immediately before admission' },
  { id: 'proofRecorded', refuse: 'PROOF_RUN_UNAVAILABLE', alsoRefuses: [{ code: 'PROOF_RUN_UNBOUND', next: 'restore the native gate receipt; do not supply provenance by hand' }, { code: 'PROOF_RUN_ACTOR', next: 'use the receipt from your own seat' }, { code: 'PROOF_RUN_STALE', next: 'read the changed criterion before running a new proof' }, { code: 'PROOF_RUN_CHANGED', next: 'keep the original receipt and run a new proof' }], rule: 'every executed proof is recorded from its native gate receipt before the item outcome', next: 'restore receipt storage and read pullboard show <id>', source: 'cli' },
  { id: 'treeStillDuringGate', refuse: 'MOVED_DURING_GATE', rule: 'when the gate ends, HEAD and every tracked file are as they were when it started', next: 'leave the worktree alone until the gate finishes, then submit again', source: 'cli' },
  { id: 'childrenDone', refuse: 'CHILDREN_OPEN', rule: 'every child item is verified or withdrawn', next: 'finish the child items, or the coordinator withdraws them', source: 'board' },
  { id: 'headIsNew', refuse: 'HEAD_NOT_NEW', rule: 'a verifier has not rejected this commit at this bar; after a no-verdict reopen, the bar was refrozen', next: 'commit the rework, or refreeze the bar after a no-verdict reopen before resubmitting the same commit', source: 'board' },
  { id: 'atSubmittedCommit', refuse: 'NOT_AT_COMMIT', alsoRefuses: [{ code: 'PIN_TOOLING_CORRUPT', next: 'delete the unreadable tooling pin file; the next landing rewrites it' }, { code: 'OUTSIDE_LANE', next: 'restore foreign paths before accepting' }, { code: 'NO_POLICY', next: 'restore the frozen policy objects' }, { code: 'BAD_CONFIG', next: 'repair the committed coordinator configuration' }, { code: 'GIT_GRAFTS', next: 'ask the coordinator to remove the Git graft file before retrying' }], rule: "the caller's checkout contains the submitted commit", next: 'git switch --detach <commit>', source: 'cli' },
  { id: 'verdictReviewRecorded', refuse: 'BAD_VERDICT_REVIEW', rule: 'a new review binds the submitted commit, its exact checked commit, a valid trunk commit and canonical candidate paths', next: 'restore the submitted Git objects and retry the review with current Pullboard', source: 'board' },
  { id: 'reviewTreeCurrent', refuse: 'STALE_VERDICT', alsoRefuses: [{ code: 'DIRTY', next: 'commit the reviewed composition before re-reviewing' }, { code: 'UNTRACKED', next: 'commit or ignore untracked files before re-reviewing' }, { code: 'VERDICT_TRUNK_MOVED', next: 'merge the latest main and re-review the clean composition' }], rule: 'a stale acceptance is re-reviewed at a clean HEAD containing the current trunk, which stays fixed through its check', next: 'merge current main into the submitted commit and re-review it', source: 'cli' },
  { id: 'notBuilder', refuse: 'SELF_VERIFY', alsoRefuses: [{ code: 'STRICT_REVIEW_TOUCHED', next: 'ask a session that has not written to this strict item' }, { code: 'BAD_REVIEW_POLICY', next: 'restore the native review policy before reviewing this item' }, { code: 'ITEM_PATCH_FORMAT', next: 'restore readable native patch metadata from its ordered history' }, { code: 'ITEM_PATCH', next: 'replace the unsafe or conflicting patch with a source-bound correction' }, { code: 'VERIFIER_STANDING', next: 'the coordinator makes an independent verifier from the main checkout: pullboard worktree <lane> --model "<model name>"' }, { code: 'SELF_SESSION_VERIFY', next: 'ask another agent session to verify it: pullboard next --verify from that session\'s own worktree' }, { code: 'REVIEW_EARLIER_HOLDER', next: 'ask a seat that never claimed, built or released this item: pullboard next --verify' }], rule: 'the decision’s verifier did not build it, and its agent session did not build or submit it under any seat; a carried verdict retains its original native authority while rechecking all author identities; for a fresh review on a linked board, at engine 48 or newer, the caller was enrolled through the relay by a line of creating seats from the coordinator that includes neither the builder nor a machine join', next: 'another agent verifies it: pullboard next --verify', source: 'board' },
  { id: 'policyAllows', refuse: 'COORDINATOR_VERIFIES', rule: "the repo's verify policy lets the caller verify this lane's work", next: 'the coordinator verifies it', source: 'board' },
  { id: 'requiredReviewFamily', refuse: 'REQUIRED_REVIEW_FAMILY', rule: 'an item required reviewer family matches the declared reviewer family case-insensitively; undeclared is ineligible', next: 'ask a reviewer whose declared family matches the item requirement', source: 'board', when: 'the item declares a required reviewer family' },
  { id: 'familyAllows', refuse: 'SAME_FAMILY', alsoRefuses: [{ code: 'LINE_SETTING_RANGE', next: 'restore the recorded board line setting to its valid value before reviewing' }, { code: 'O2_FAMILY_MATCH', next: 'ask the coordinator for a verifier from another declared family' }], rule: 'strict reviews require different declared vendor families; the existing vendor policy and explicit board or item family requirements also apply', next: 'ask the coordinator for a verifier from another declared family', source: 'board', when: 'when the item is strict, verify.family is require, an item requires a family, or requireReviewFamilies is on for unknown families' },
  { id: 'reviewFree', refuse: 'REVIEW_HELD', rule: 'no other agent holds its review under a live lease', next: 'pullboard next --verify, which passes over reviews another agent holds', source: 'board' },
  { id: 'reasonIsMet', refuse: 'BAD_REASON', rule: 'an accept gives CRITERION_MET as its reason', next: 'a failed criterion is a reject: pullboard verify <id> reject --reason CODE --clause "<frozen wording>"', source: 'board' },
  { id: 'proofNoted', refuse: 'PROOF_REQUIRED', rule: 'an accept notes how it was proved', next: '--note "what you broke or which edge you tried, and what happened"', source: 'board' },
  { id: 'reasonCoded', refuse: 'BAD_REASON', rule: 'a reject names one of the reject reasons', next: '--reason TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD or OTHER', source: 'board' },
  { id: 'reviewReleaseExplained', refuse: 'NOTE_REQUIRED', rule: 'a review release gives a nonempty one-line reason', next: 'release with --note "why", or --note-file <file>', source: 'board', when: 'engine 5 or newer, only when freeing a submitted review reservation' },
  { id: 'reviewCooldownElapsed', refuse: 'REVIEW_COOLDOWN', rule: 'the reviewer has not released this submission within the past hour', next: 'let another reviewer take it, or wait an hour or for a new submission', source: 'board', when: 'engine 5 or newer, only for the same reviewer and current submission' },
  { id: 'noteGiven', refuse: 'NOTE_REQUIRED', rule: 'the move carries a note: what failed, what was tried, or why', next: '--note "..." or --note-file <file>', source: 'board' },
  { id: 'mainRedUnchanged', refuse: 'STALE_MAIN_RED', alsoRefuses: [{ code: 'NO_POLICY', next: 'restore the primary repository metadata, then rerun the native main audit' }], rule: 'an audit withdrawal still names the exact open frozen Main red and its audited source head', next: 'rerun the native main audit against the current frozen item', source: 'board', when: 'only expected-item main-audit withdrawals' },
  { id: 'clauseWellFormed', refuse: 'BAR_CLAUSE_REQUIRED', alsoRefuses: [{ code: 'BAR_CLAUSE_UNKNOWN', next: 'read pullboard show <id>, then quote the failing requirement with --clause' }, { code: 'LINE_SETTING_RANGE', next: 'read the allowed range with pullboard settings line, then record an in-range value or off with its reason and window numbers' }], rule: 'a current rejection names wording in its frozen bar', next: 'add --clause \"exact wording from the frozen criterion or spec row\"', source: 'board' },
  { id: 'causeWellFormed', refuse: 'BAD_CAUSE', rule: 'a cause, when given, is test:<file>::<title>, refusal:<CODE>, row:<id>, doctrine:<id> or sentinel:<name>', next: 'fix --cause, or leave it out', source: 'board' },
  { id: 'notMerged', refuse: 'ALREADY_MERGED', rule: 'the item has no recorded merge receipt', next: 'a merged item cannot be reopened', source: 'board' },
  { id: 'submissionProofValid', refuse: 'SUBMISSION_PROOF',
    alsoRefuses: [
      { code: "NO_TITLE", next: "give a title: pullboard add <lane> \"<title>\"" },
      { code: "PARENT_LANE", next: "add the child in its parent's lane" },
      { code: "PARENT_CLOSED", next: "add the item without --parent, or under an open parent" },
      { code: "COORDINATOR_CHECK", next: "ask your coordinator to set the check: pullboard shout coordinator --kind question \"please set a check on #<id>\"" },
      { code: "BAD_CHECK", next: "ask your coordinator to set the check: pullboard edit <id> --check \"<command>\"" },
      { code: "BAD_REVIEW_FAMILY", next: "use --review-family with a nonempty declared reviewer family of at most 100 characters" },
      { code: "REFERENCE_IS_BOARD", next: "use --specs for spec rows, --after for item dependencies, or --parent for a parent item" },
      { code: "B26_PERSON_CHANNEL", next: "record it as the person through pullboard view or the person's own terminal" },
      { code: "REFERENCE_AUTHOR", next: "use the issue or pull request author's handle, or remove the handle from its Reference line, then add or edit the item again" },
      { code: "BRIEF_TOO_LONG", next: "shorten the brief and point to a longer doc by path, or pass --brief-file <file>" },
      { code: "NO_BRIEF", next: "add the missing fields with pullboard edit <id> --brief \"...\" --criterion \"...\"" },
      { code: "CHECK_MASKS_EXIT", next: "set the check to run its proof alone, or capture the output first and test it, then retry: pullboard edit <id> --check \"<command>\"" },
      { code: "WITHDRAWN", next: "wait on an item that is not withdrawn; see pullboard list --all" },
      { code: "DEPENDENCY_CYCLE", next: "change --after so no item waits on itself" },
      { code: "BAD_CHECK_BASELINE", next: "the coordinator sets the check again: pullboard edit <id> --check \"<command>\"" },
      { code: "BAR_PARENT_UNKNOWN", next: "join a fresh worktree from the current native session with its real parent; an outside session must sign a bar whose author identities are known" },
    ],
    rule: 'recorded test selection names literal project files and its full-fallback policy; derived Main red repairs meet ordinary item validation',
    next: 'rerun submit with the current CLI', source: 'board',
    when: 'engine 38 or later; absent legacy selection remains unknown; derived repairs require their engine-fenced submit path' },
  { id: 'landingFailureRecorded', refuse: 'LANDING_FAILURE_REQUIRED', rule: 'a verified item note names the failing test and landing merge commit', next: 'cite the recorded batch, or name the test and merge commit in a manual note; work that only conflicts with the trunk reopens with --conflict <file> for each conflicting file', source: 'board', when: 'unless the reopen names a trunk conflict' },
  { id: 'trunkConflicts', refuse: 'NOT_CONFLICTING', alsoRefuses: [{ code: 'CONFLICT_FILES', next: 'name only files Git reports as conflicting with the trunk' }, { code: 'NO_TRUNK', next: 'check out the trunk branch in the main checkout once and run pullboard inbox' }, { code: 'MERGE_CHECK_FAILED', next: 'use Git 2.38 or newer, restore its objects and retry' }], rule: 'the accepted commit no longer merges onto the trunk, and every named file is one that conflicts', next: 'merge it, or reopen after a red landing with --note "<test file>: <test name>; merge commit <sha>"', source: 'cli', when: 'only for reopen --conflict by the coordinator on accepted, unmerged work' },
  { id: 'conflictAccepted', refuse: 'NOT_ACCEPTED', alsoRefuses: [{ code: 'BAD_CONFLICT', next: 'run pullboard reopen <id> --conflict <file> from the main checkout' }, { code: 'ENGINE_VERSION', next: 'upgrade Pullboard on every linked device before using --conflict' }], rule: 'a trunk conflict reopens an accepted item, names its files and the full trunk commit, and replays only under engine 52 or later', next: 'reopen a submission with --note "why"', source: 'board', when: 'only for reopen --conflict' },
];

/** @type {Move[]} */
export const MOVES = [
  ...patchMoves,
  ...rehomeImportMoves,
  ...intakeMoves,
  ...claimMoves,
  ...releaseMoves,
  ...lapseMoves,
  ...submitMoves,
  ...submitMergeMoves,
  ...reserveMoves,
  ...acceptMoves,
  ...rejectMoves,
  ...reopenMoves,
  ...escalateMoves,
  ...refreezeMoves,
  ...withdrawMoves,
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
export const UNKNOWN_MOVE = { refuse: 'BAD_DECISION', rule: 'a verdict is accept or reject', next: 'pullboard verify <id> accept, or reject --reason CODE --clause "<frozen wording>" --note "..."' };

/** @type {Machine} */
export const MACHINE = { roles: ROLES, initial: INITIAL, records: RECORDS, states: STATES, guards: GUARDS, moves: MOVES, exitGuards: EXIT_GUARDS, unknownMove: UNKNOWN_MOVE };
