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
      { code: 'TEST_HASH_CHANGED', rule: 'a test file the frozen bar named keeps its frozen content unless the person ruled on the new content', next: 'restore the file, or ask the coordinator to bring the change to the person for a test-hash ruling' },
      { code: 'TEST_AUTHOR_SAME_SEAT', rule: 'when verify.testAuthorSplit is on, a bar-named test file the submitting seat changed was authored by another seat', next: 'restore the test to accepted main and build against it as written, or have another seat write it and record itself as the author' },
      { code: 'SLICE_PATHS', rule: 'when slices.enforcePaths is on, a slice changes only paths its declared set owns', next: 'revert the outside path, or ask the parent holder for a slice that declares it' },
      { code: 'EMPTY_SUBMIT', rule: 'the submitted source changes accepted main', next: 'commit the item work in its native item folder, then submit' },
      { code: 'KERNEL_EXPORT_APPROVAL', rule: 'the person approved the exact Kernel front-door change', next: 'ask the coordinator to bring the exact export decision to the person' },
      { code: 'KERNEL_EXPORT_SOURCE', rule: 'Kernel interface inspection reads regular committed files', next: 'restore regular committed Kernel source files' },
      { code: 'SEAL_REVISION', rule: 'test selection reads an existing committed seal revision', next: 'restore the named Git revision and objects' },
      { code: 'SEAL_STALE', rule: 'every skipped package retains its current native seal receipt', next: 'run tests of unsealed packages and derive a fresh selection' },
      { code: 'SEAL_STORE', rule: 'native test seals are read from the repository common directory', next: 'restore the repository Git metadata and seal storage' },
      { code: 'LANE_CHECK_FOREIGN', rule: 'a lane seat\'s frozen check names only test files its own lane owns', next: 'shout the owning lane or the coordinator to set a check that names the file' },
      { code: 'WRONG_BRANCH', rule: 'the new commits at the head name this item, not another', next: 'submit the other item from here, or switch to the branch built for this item' },
      { code: 'BAR_EMPTY', rule: 'a criterion with no text freezes only while freeze.refuseEmptyBar is off', next: 'ask the coordinator to give the item numbered clauses: pullboard edit <id> --criterion "1. ... [test]" --reason "..."' },
      { code: 'UNKNOWN_SPEC', rule: 'the submitted criterion cites governing approved rows', next: 'restore the governing spec rows or ask the coordinator to correct the item' },
      { code: 'TEST_SELECTION_SOURCE', rule: 'the immutable test-selection source is readable from Git', next: 'restore Git history and retry the selected test run' },
      { code: 'TEST_TIER_MANIFEST', rule: 'a tier-enabled project retains a valid generated test manifest', next: 'regenerate and commit the testing tier manifest' },
      { code: 'TEST_SELECTION_INCOMPLETE', rule: 'the supplied changed paths exactly match the committed Git diff', next: 'derive test selection from the complete committed diff' },
      { code: 'TEST_SELECTION_UNVERIFIED', rule: 'a green selected test run includes an observed test account', next: 'make the focused runner execute and report the selected tests' },

      { code: 'SUBMIT_HANDOFF_CHANGED', rule: 'the queued owner, captured source, companions and frozen bar still match', next: 'read the current claim and queued result; do not act for an old job' },
      { code: 'SUBMIT_HANDOFF_AUTHORITY', rule: 'a queued worker acts only for its exact native job and proved source', next: 'finish the captured job through its native worker; use the registered seat for other work' },
      { code: 'GENERATED_STALE', rule: 'with submit.regenerateDeclared on, every declared generated file regenerates cleanly in the composed tree', next: 'run the generator yourself, commit, and submit again' },
      { code: 'JOB_CENSUS_CAP', rule: 'a census job\'s censusPerRunner is a whole number of jobs, 1 or more', next: 'offer it with census.jobsPerRunner as set, or none' },
      { code: 'SUBMIT_HANDOFF_PENDING', rule: 'an unfinished queued candidate is retained until its terminal result', next: 'leave the captured candidate unchanged and read its queued result with pullboard show <id>' },
{ code: 'ENGINE_VERSION', rule: 'computed quarantine outcomes are replayed by an engine defining their event-bound blocking authority', next: 'upgrade Pullboard: npm install -g pullboard@latest' }, ...BOARD_SHAPE_REFUSALS, { code: 'BAD_DEPENDENCIES', rule: 'persisted prerequisites contain only positive local item ids or exact repo#id references', next: 'restore the item dependencies from their ordered history, then retry' }, ...AGENT_GRANT_REFUSALS, { code: 'LINE_SETTING_RANGE', rule: 'the recorded board line setting has a valid registry value', next: 'restore the recorded board line setting from its ordered event history, then retry submit' },
      { code: 'CELLS_PLAN_SHARD', rule: 'each immutable cell plan shard is present, regular and canonically named', next: "regenerate the plan and its shards with node packages/codemap/src/io/cells/scripts/plan.js --write" },
      { code: 'CELLS_UNPLACED', rule: 'every composed source path has a valid explicit cell placement', next: "add a name rule for the reported paths in src/cells-plan.js, then regenerate the plan with node packages/codemap/src/io/cells/scripts/plan.js --write" },
      { code: 'CELLS_PLAN_COUNTS', rule: 'cell placement sources and cut counts are valid inputs to derived plan counters', next: 'repair the named placement source or cut count, commit, then submit again' },
      { code: 'UNDECLARED_BUILDER_FAMILY', rule: 'a strict item is submitted by a builder with a declared vendor family', next: 'rejoin with: pullboard join <lane> --family <vendor> --model "<model name>", then submit again' },
      { code: 'BAD_REVIEW_POLICY', rule: 'the native review policy of the item is readable', next: 'restore the native review policy before reviewing this item' },
      { code: 'MERGE_ONLY_PROOF', rule: 'a requested carry matches the recorded conflict return, acceptance and exact gated source', next: 'submit normally for outside review' },
      { code: 'SELF_VERIFY', rule: 'the retained original verifier did not author the merge resubmission', next: 'submit the changed source for outside review' },
      { code: 'SELF_SESSION_VERIFY', rule: 'the retained verifier shares no author parent with the resubmitting builder', next: 'submit for another parent session to review' },
      { code: 'PROOF_REQUIRED', rule: 'a carried acceptance records the actual resolution diff', next: 'submit with the current CLI or get an outside review' },
      { code: 'NOT_SUBMITTED', rule: 'machine acceptance applies only while the item is still submitted', next: 'read the item with pullboard show, then submit again if it reopened' }],
    guards: ['joined', 'itemExists', IN_STATE, 'isHolder', 'correctionRefrozen', 'checkProvesSomething', 'barReady', 'clausesInspected', 'criterionUnchanged', 'treeClean', 'nothingUntracked', 'hasCommit', 'withinLane', 'trunkMergeClean', 'trunkInCandidate', 'noUnverifiedStack', 'doctrineHolds', 'gateConfigured', 'queuedItemLease', 'gateGreen', 'proofRecorded', 'submissionProofValid', 'childrenDone', 'headIsNew'],
    sets: ['item_built_by', 'item_commit'], command: 'pullboard submit <id>',
  },
];
