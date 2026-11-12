import { IN_STATE } from '../shared.js';
import { BOARD_SHAPE_REFUSALS } from '../shared.js';
import { AGENT_GRANT_REFUSALS } from '../shared.js';
import { SUBMIT_REACHED_REFUSALS } from '../shared.js';

/**
 * The `submit` lifecycle move, declared in its own module so a change to one move's
 * guards never edits the file every other move shares; packages/state/src/io/machine.js lists every move in order [M1,C7].
 *
 * @type {import('../../../io/machine.js').Move[]}
 */
export const MOVES = [
  {
    verb: 'submit', from: ['claimed'], to: 'submitted', by: ['agent', 'coordinator'], refuse: 'NOT_YOURS',
    alsoRefuses: [
      ...SUBMIT_REACHED_REFUSALS,
      { code: 'AGENT_APPROVAL_REQUIRED', rule: 'cited rows satisfy the accepted person approval policy', next: 'ask the coordinator to arrange the person confirmation or decline' },
      { code: 'CLAUSE_EVIDENCE_KIND', rule: 'each frozen clause names one evidence kind', next: 'split outcomes or choose one evidence kind per clause' },
      { code: 'CLAUSE_EVIDENCE_REQUIRED', rule: 'each frozen clause declares its evidence kind', next: 'ask the coordinator to declare the missing clause evidence kind' },
      { code: 'CLAUSE_REASONING_ONLY', rule: 'observable outcomes require observable evidence', next: 'declare test, command, screenshot or measurement evidence' },
      { code: 'SUBMIT_RED_LOOP', rule: 'two red test gates that still match the item code stop another unchanged submit', next: 'change the failing code before another submit' },
      { code: 'BAR_PATH_MISSING', rule: 'every path the frozen bar names exists on main', next: 'name the paths where they live on main now (pullboard edit <id> --criterion/--check/--brief), or withdraw the item' },
      { code: 'EMPTY_SUBMIT', rule: 'the submitted source changes accepted main', next: 'commit the item work in its native item folder, then submit' },
      { code: 'KERNEL_EXPORT_APPROVAL', rule: 'the person approved the exact Kernel front-door change', next: 'ask the coordinator to bring the exact export decision to the person' },
      { code: 'KERNEL_EXPORT_SOURCE', rule: 'Kernel interface inspection reads regular committed files', next: 'restore regular committed Kernel source files' },
      { code: 'SEAL_REVISION', rule: 'test selection reads an existing committed seal revision', next: 'restore the named Git revision and objects' },
      { code: 'SEAL_STALE', rule: 'every skipped package retains its current native seal receipt', next: 'run tests of unsealed packages and derive a fresh selection' },
      { code: 'SEAL_STORE', rule: 'native test seals are read from the repository common directory', next: 'restore the repository Git metadata and seal storage' },
      { code: 'LANE_CHECK_FOREIGN', rule: 'a lane seat\'s frozen check names only test files its own lane owns', next: 'shout the owning lane or the coordinator to set a check that names the file' },
      { code: 'WRONG_BRANCH', rule: 'the new commits at the head name this item, not another', next: 'submit the other item from here, or switch to the branch built for this item' },
      { code: 'UNKNOWN_SPEC', rule: 'the submitted criterion cites governing approved rows', next: 'restore the governing spec rows or ask the coordinator to correct the item' },
      { code: 'TEST_SELECTION_SOURCE', rule: 'the immutable test-selection source is readable from Git', next: 'restore Git history and retry the selected test run' },
      { code: 'TEST_TIER_MANIFEST', rule: 'a tier-enabled project retains a valid generated test manifest', next: 'regenerate and commit the testing tier manifest' },
      { code: 'TEST_SELECTION_INCOMPLETE', rule: 'the supplied changed paths exactly match the committed Git diff', next: 'derive test selection from the complete committed diff' },
      { code: 'TEST_SELECTION_UNVERIFIED', rule: 'a green selected test run includes an observed test account', next: 'make the focused runner execute and report the selected tests' },

      { code: 'SUBMIT_HANDOFF_CHANGED', rule: 'the queued owner, captured source, companions and frozen bar still match', next: 'read the current claim and queued result; do not act for an old job' },
      { code: 'SUBMIT_HANDOFF_AUTHORITY', rule: 'a queued worker acts only for its exact native job and proved source', next: 'finish the captured job through its native worker; use the registered seat for other work' },
      { code: 'SUBMIT_HANDOFF_PENDING', rule: 'an unfinished queued candidate is retained until its terminal result', next: 'leave the captured candidate unchanged and read its queued result with pullboard show <id>' },
{ code: 'ENGINE_VERSION', rule: 'computed quarantine outcomes are replayed by an engine defining their event-bound blocking authority', next: 'upgrade Pullboard: npm install -g pullboard@latest' }, ...BOARD_SHAPE_REFUSALS, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }, ...AGENT_GRANT_REFUSALS, { code: 'LINE_SETTING_RANGE', rule: 'the recorded board line setting has a valid registry value', next: 'restore the recorded board line setting from its ordered event history, then retry submit' },
      { code: 'CELLS_PLAN_SHARD', rule: 'each immutable cell plan shard is present, regular and canonically named', next: "regenerate the plan and its shards with node packages/codemap/src/io/cells/scripts/plan.js --write" },
      { code: 'CELLS_UNPLACED', rule: 'every composed source path has a valid explicit cell placement', next: "add a name rule for the reported paths in src/cells-plan.js, then regenerate the plan with node packages/codemap/src/io/cells/scripts/plan.js --write" },
      { code: 'CELLS_PLAN_COUNTS', rule: 'cell placement sources and cut counts are valid inputs to derived plan counters', next: 'repair the named placement source or cut count, commit, then submit again' },
      { code: 'CELLS_PLAN_RETIRED', rule: 'retired paths satisfy their canonical retirement contracts', next: 'repair the named retirement contract or retain its original placement, commit, then submit again' },
      { code: 'CELLS_PLAN_GIT', rule: 'the immutable cell snapshots can be inspected through Git', next: "run node packages/codemap/src/io/cells/scripts/plan.js inside a Git checkout of this repository" },
      { code: 'CELL_BASELINE', rule: 'accepted main has a complete valid cell lint baseline', next: "run node packages/codemap/src/io/cell/scripts/lints.js --report; restore the complete accepted packages/codemap/data/baselines/lints descriptor and hash-bound shards, resolve reported inventory or ownership conflicts, then run node packages/codemap/src/io/cell/scripts/lints.js --check; initialize with --init only when no accepted baseline exists after explicit review" },
      { code: 'CELLS_PLAN_CELL', rule: 'each compared cell exists in the immutable plan', next: "use a cell name listed in packages/codemap/data/plan/cells.json, as in node packages/codemap/src/io/cells/scripts/plan.js --moved kernel" },
      { code: 'CELLS_ENTRY', rule: 'explicit process ownership is bound to a regular compiled process entry in the declared app cell', next: 'restore the named process entry source or correct its explicit app placement, commit, then submit again' },
      { code: 'CELLS_SUBMIT', rule: 'the immutable composition has no unplaced source, new touched-cell diagnostic or lint growth over accepted authority', next: 'repair the named cell diagnostic or placement, commit, then submit again' },
      { code: 'UNDECLARED_BUILDER_FAMILY', rule: 'a strict item is submitted by a builder with a declared vendor family', next: 'rejoin with: pullboard join <lane> --family <vendor> --model "<model name>", then submit again' },
      { code: 'BAD_REVIEW_POLICY', rule: 'the native review policy of the item is readable', next: 'restore the native review policy before reviewing this item' },
      { code: 'MERGE_ONLY_PROOF', rule: 'a requested carry matches the recorded conflict return, acceptance and exact gated source', next: 'submit normally for outside review' },
      { code: 'SELF_VERIFY', rule: 'the retained original verifier did not author the merge resubmission', next: 'submit the changed source for outside review' },
      { code: 'SELF_SESSION_VERIFY', rule: 'the retained verifier shares no author parent with the resubmitting builder', next: 'submit for another parent session to review' },
      { code: 'PROOF_REQUIRED', rule: 'a carried acceptance records the actual resolution diff', next: 'submit with the current CLI or get an outside review' }],
    guards: ['joined', 'itemExists', IN_STATE, 'isHolder', 'correctionRefrozen', 'checkProvesSomething', 'barReady', 'clausesInspected', 'criterionUnchanged', 'treeClean', 'nothingUntracked', 'hasCommit', 'withinLane', 'trunkMergeClean', 'sourcePlaced', 'trunkInCandidate', 'noUnverifiedStack', 'doctrineHolds', 'gateConfigured', 'queuedItemLease', 'gateGreen', 'proofRecorded', 'treeStillDuringGate', 'submissionProofValid', 'childrenDone', 'headIsNew'],
    sets: ['item_built_by', 'item_commit'], command: 'pullboard submit <id>',
  },
];
