import { ENGINE_VERSION } from '../../../../state/light.js';
import { MACHINE_VERDICT_ENGINE } from '../../../../state/light.js';
import { STRICT_RENAME_ENGINE } from '../../../../state/light.js';
import { MAIN_RED_FAILURE_LINES_ENGINE } from '../../../../state/light.js';
import { CLAUSE_INSPECTION_ENGINE } from '../../../../state/light.js';
import { KNOWN_MAIN_AUTOFILE_ENGINE } from "../../../../state/light.js";
import { KNOWN_MAIN_OWNER_PATTERN_ENGINE } from "../../../../state/light.js";
import { QUARANTINE_VERDICT_ENGINE } from "../../../../state/light.js";
import { itemReviewPolicyEngine } from "../../../../verify/browser.js";
import { checkTimingEngine } from "../../../../items/browser.js";
import { itemPatchRecords } from "../../../../items/browser.js";
import { ITEM_PATCH_SUBMIT_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
import { MERGE_ONLY_VERDICT_ENGINE } from "../../../../state/light.js";
import { FLOW_SIZE_ENGINE } from "../../../../state/light.js";
import { KNOWN_MAIN_REWORKS_ENGINE } from "../../../../state/light.js";
import { KNOWN_MAIN_RUNNING_FILE_ENGINE } from "../../../../state/light.js";
import { KNOWN_MAIN_RECEIPT_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by submit, discovered without a shared registry edit [C7,V4,H16]. */
import { SUBMIT_COMMAND_NEXT } from "../table/next.js";
import { BAR_READY_ENGINE } from "../../../../state/light.js";
import { barReadySetting } from "../bar/ready.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { OUTSIDE_INTAKE_ENGINE } from "../../../../state/light.js";
import { outsideSource } from "../../../../items/browser.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { BAR_CHECK_ENGINE } from "../../../../state/light.js";
import { barCheckEnabled } from "../../../../verify/browser.js";
import { SUBMISSION_PROOF_ENGINE } from "../../../../state/light.js";
import { submissionProof } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  const barCheck = board && barCheckEnabled(board) ? BAR_CHECK_ENGINE : 1;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return Math.max(checkTimingEngine(board, args[0]), barCheck, RIGOR_AUTO_ENGINE);
  if (board && barReadySetting(board).enabled) return Math.max(barCheck, BAR_READY_ENGINE);
  if (args[0]?.landingFence !== undefined) return Math.max(barCheck, LANDING_LEASE_ENGINE);
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return Math.max(barCheck, BOARD_SENTINEL_ENGINE);
  if (args[1]?.submissionProof !== undefined) return Math.max(barCheck, SUBMISSION_PROOF_ENGINE);
  return barCheck;
}
/** Keep outside-source isolation as the original maximum over the older engine rule. */
function minimumEngine(args, board, at) {
  const outside = board && Boolean(outsideSource(board, args[0]));
  const presubmit = board && itemPatchRecords(board, args[0]).some(record => record.presubmit === true);
  const errorLines = args[1]?.autoMainReds?.comparisons?.some(receipt => receipt.failureSignatures?.failures?.some(row => row.firstError !== undefined))
    || args[1]?.submissionProof?.knownMainFailures?.failures?.some(row => row?.firstError !== undefined || row?.stable !== undefined);
  return Math.max(args[1]?.machineVerified !== undefined || args[1]?.machineReceipts !== undefined ? MACHINE_VERDICT_ENGINE : 1, args[1]?.strictRenames !== undefined ? STRICT_RENAME_ENGINE : 1, errorLines ? MAIN_RED_FAILURE_LINES_ENGINE : 1, Object.hasOwn(args[1] ?? {}, 'clausePolicyCommit') || args[1]?.inspectClauses === true ? CLAUSE_INSPECTION_ENGINE : 1, args[1]?.autoMainReds !== undefined ? KNOWN_MAIN_AUTOFILE_ENGINE : 1, Object.hasOwn(args[1] ?? {}, 'quarantineProofIds') ? QUARANTINE_VERDICT_ENGINE : 1, itemReviewPolicyEngine(board, args[0]), args[1]?.companion || presubmit ? ITEM_PATCH_SUBMIT_ENGINE : 1, args[1]?.gateGreen !== undefined ? MERGE_ONLY_VERDICT_ENGINE : 1,
    Array.isArray(args[1]?.submissionProof?.knownMainFailures?.failures)
      && args[1].submissionProof.knownMainFailures.failures.some(row => row?.item !== undefined)
      ? args[1].submissionProof.knownMainFailures.failures.some(row => row?.ran !== undefined)
        ? KNOWN_MAIN_RUNNING_FILE_ENGINE
        : (board?.executionEngineVersion ?? ENGINE_VERSION) >= KNOWN_MAIN_OWNER_PATTERN_ENGINE
          ? KNOWN_MAIN_OWNER_PATTERN_ENGINE : KNOWN_MAIN_REWORKS_ENGINE
      : 1,
    // A known main failure citing its main receipt needs the engine that keeps that id [V4,B3,H16].
    args[1]?.submissionProof?.knownMainFailures?.failures?.some?.(row => row?.receipt !== undefined) ? KNOWN_MAIN_RECEIPT_ENGINE : 1,
    args[1]?.submissionSize !== undefined ? FLOW_SIZE_ENGINE : 1,
    outside ? OUTSIDE_INTAKE_ENGINE : 1, existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "submit", order: 15, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  ...SUBMIT_COMMAND_NEXT,
  "CLAUSE_UNTICKED": "tick each named clause with its declared evidence kind using pullboard fact <id> note, then submit again",
  "TEST_SELECTION_SOURCE": "restore Git history and retry the selected test run",
  "TEST_TIER_MANIFEST": "regenerate and commit the testing tier manifest",
  "TEST_SELECTION_INCOMPLETE": "derive test selection from the complete committed diff",
  "TEST_SELECTION_UNVERIFIED": "make the focused runner execute and report the selected tests",

  "B26_PERSON_CHANNEL": "record it as the person through pullboard view or the person's own terminal",
  "BAD_CHECK": "ask your coordinator to set the check: pullboard edit <id> --check \"<command>\"",
  "BAD_CHECK_BASELINE": "the coordinator sets the check again: pullboard edit <id> --check \"<command>\"",
  "BAD_REVIEW_FAMILY": "use --review-family with a nonempty declared reviewer family of at most 100 characters",
  "BAR_PARENT_UNKNOWN": "join a fresh worktree from the current native session with its real parent; an outside session must sign a bar whose author identities are known",
  "BRIEF_TOO_LONG": "shorten the brief and point to a longer doc by path, or pass --brief-file <file>",
  "CHECK_MASKS_EXIT": "set the check to run its proof alone, or capture the output first and test it, then retry: pullboard edit <id> --check \"<command>\"",
  "COORDINATOR_CHECK": "ask your coordinator to set the check: pullboard shout coordinator --kind question \"please set a check on #<id>\"",
  "DEPENDENCY_CYCLE": "change --after so no item waits on itself",
  "NO_BRIEF": "add the missing fields with pullboard edit <id> --brief \"...\" --criterion \"...\"",
  "NO_TITLE": "give a title: pullboard add <lane> \"<title>\"",
  "PARENT_CLOSED": "add the item without --parent, or under an open parent",
  "PARENT_LANE": "add the child in its parent's lane",
  "REFERENCE_AUTHOR": "use the issue or pull request author's handle, or remove the handle from its Reference line, then add or edit the item again",
  "REFERENCE_IS_BOARD": "use --specs for spec rows, --after for item dependencies, or --parent for a parent item",
  "WITHDRAWN": "choose an item that is not withdrawn: pullboard list --all",
  "RUNNER_UNAVAILABLE": "inspect the unavailable runner and its exact cleanup generation; restore it before another attempt",
  "RUNNER_JOB_LOST": "inspect the exact runner and job named in the diagnostic; cleanup remains unknown until the pinned worker proves it, then retry",
  "SUBMIT_PIN_NOT_MAIN": "run pullboard submit again so it captures the current main",
  "RUNNER_WORK_SPEC": "upgrade or repair the controller and runner together, then retry the named invalid work specification",
  "RUNNER_LIFECYCLE_PROVIDER": "restart with the current installed controller so its canonical item lifecycle observer is composed",
  "A5_GRAMMAR_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "BAD_CONFIG": "fix pullboard.json as the message says, then commit it: git commit -m \"chore: fix pullboard config\" pullboard.json",
  "BAD_REVIEW_POLICY": 'restore the native review policy before reviewing this item',
  "RUNS_BOARD_MISMATCH": "move the stray runs file aside; the board rebuilds in-flight work from its run rows",
  "BAR_EMPTY": "ask the coordinator to give the item numbered clauses: pullboard edit <id> --criterion \"1. ... [test]\" --reason \"...\"",
  "BAR_NOT_READY":"read pullboard bar <id>; ask its author to complete the named red baseline and measurement/edge notes, then have an outside parent session sign the current bar",
  "CHECK_OVER_CEILING": "cut the check so it runs inside its ceiling, or ask the coordinator to re-bar the item, then submit again",
  "CHECK_UNSOUND": "re-measure the strict check with the check baseline, then submit again",
  "CELLS_PLAN_COUNTS": "repair the named placement source or cut count, commit, then submit again",
  "CELLS_PLAN_ORDER": "restore the named missing cell prerequisite in the plan, commit, then submit again",
  "CELLS_PLAN_ORDER_CYCLE": "remove an uncut dependency in the named cell cycle, commit, then submit again",
  "CELLS_PLAN_RETIRED": "repair the named retirement contract or retain its original placement, commit, then submit again",
  "CELLS_SUBMIT": "repair the named new cell diagnostic or unplaced path, commit it, then submit again",
  "CRITERION_PROVES_NOTHING": "set a check that fails before the work: pullboard edit <id> --check \"<command>\", or ask the person to accept this one: pullboard check accept <id>",
  "DIRTY": "commit your changes, then run the command again",
  "HOSTED_BRANCH_MISMATCH": "on the runner, check out the claimed item branch in the item folder, then run pullboard submit <id> again",
  "HOSTED_PUSH_FAILED": "on the runner, fix the push the message names (git pull origin <branch> when the coordinator branch moved), then run pullboard submit <id> again",
  "GATE_RED": "fix what the gate report names, commit, and submit again",
  "GIT_GRAFTS": "ask the coordinator to remove the git graft file: pullboard shout coordinator --kind question \"please remove .git/info/grafts\"",
  "HOST_NAME": "reword the named commit's message without this machine's name (git rebase -i, then reword), then run pullboard submit <id> again",
  "ITEM_LEASE_LOST": "read pullboard show <id>; if the item is free, claim it again for a build or reserve it with pullboard next --verify <id> for a review, then retry",
  "LAND_GATE_OUTPUT": "inspect the retained timed gate output directory and free disk space, then start another landing",
  "LAND_TIMEOUT_CUSTODY": "inspect the saved timed gate cleanup state and stop only its proven owned processes before starting another landing",
  "MAIN_NOT_COMPOSED": "run pullboard submit again, which composes current main; for an unrecorded recovered move, run pullboard inbox first or ask the coordinator to resolve the pending receipt",
  "MERGE_ONLY_PROOF": "submit the exact gated merge with the unchanged frozen criterion, or leave the new head for outside review",
  "MERGE_CHECK_FAILED": "use Git 2.38 or newer (git --version), then retry",
  "MERGE_CONFLICT": "merge main into your branch, resolve the conflicts, commit, and run the command again",
  "MOVED_DURING_GATE": "leave the worktree alone until the gate finishes, then submit again",
  "NOT_A_REPO": "cd into a git repo, or make one: git init",
  "CHECK_FILE_MISSING": "commit the test file the frozen check names, or ask the coordinator to correct the check, then submit again",
  "NO_COMMIT": "commit your work, or name a commit that exists: git log --oneline",
  "NO_CONFIG": "run pullboard init in the main checkout and commit pullboard.json",
  "NO_GATE": "in the main checkout, run pullboard gate set \"<project test command>\", then commit pullboard.json",
  "NO_POLICY": "restore and commit pullboard.json, then run the command again",
  "NO_TRUNK": "in the main checkout, switch to the repository’s trunk branch and run pullboard inbox",
  "OUTSIDE_LANE": "move those changes out of this commit, and shout the lane that owns them: pullboard shout <lane> \"<text>\"",
  "PIPEFAIL_UNAVAILABLE": "rewrite the gate in pullboard.json without a pipe",
  "RATCHET_ROSE": "fix the new doctrine problems named in the report, commit, and submit again; only the person can sign an increased count",
  "RATCHET_UNCOUNTED": "fix the named doctrine check to exit zero or one within its configured timeout, or ask the coordinator to repair it, then submit again",
  "RUNNER_TOOLING_CRASH": "shout the coordinator with this refusal word for word: main's pinned tooling throws, and only a fix landed on main clears it",
  "RUNNER_RESULT_INVALID": "inspect the retained transport diagnostic and repair the named protocol or capsule failure before retrying",
  "RUNNER_INFRA_RETRY_EXHAUSTED": "inspect the retained runner diagnostic, restore the named runner, then retry this command",
  "RUNNER_BROWSER_SLOT_REQUIRED": "nothing to do: the run reruns on a local gate slot; if it repeats, set gate.browserByLaunch the same on this machine and that runner",
  "SESSION_LEDGER": "make the agent-session ledger named in the message writable by this user, then run the command again",
  "RUNNER_WAIT_DEADLINE": "check the runners the message names, or restore local gate capacity with pullboard settings, then retry",
  "SLOT_DB_LOCKED": "the run never started, so it is not a red; rerun the same command once the named process releases the slot database",
  "STACKED_ON_UNVERIFIED": "rebuild on main without the unverified earlier commits, or take other work with pullboard next",
  "ITEM_PATCH": "inspect the native patches with pullboard patch list <item>; ask the coordinator to replace unsafe or conflicting input",
  "ITEM_PATCH_SOURCE": "bind patches to the exact submitted commit and compose them before review",
  "ITEM_PATCH_CHANGED": "read and compose the current patch set before reviewing",
  "ITEM_PATCH_AUTHOR": "name an existing native author seat",
  "SUBMISSION_PROOF": "rerun pullboard submit <id> with the current CLI so its selected files and fallback are recorded",
  "TIMING_RUNNER_RESTRICTION": "adjust the runner restriction or gate.timingRunner setting named in the refusal, then retry submit",
  "TIMING_SLOT_REQUIRED": "start the timing check outside its inherited ordinary lease and acquire the machine gate with timing true",
  "UNDECLARED_BUILDER_FAMILY": "rejoin with your vendor family: pullboard join <lane> --family <vendor> --model \"<model name>\", then submit again",
  "UNTRACKED":"commit or ignore the untracked files, then run the command again",
}) });
