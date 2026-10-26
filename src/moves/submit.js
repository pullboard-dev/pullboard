import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
import { FLOW_SIZE_ENGINE } from '../flow-size-engine.js';
/** Routing metadata owned by submit, discovered without a shared registry edit [C7,V4,H16]. */
import { BAR_READY_ENGINE } from '../bar-ready-engine.js';
import { barReadySetting } from '../bar-ready-setting.js';
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { OUTSIDE_INTAKE_ENGINE } from '../outside-intake-engine.js';
import { outsideSource } from '../outside-source.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';
import { BAR_CHECK_ENGINE } from '../bar-check-engine.js';
import { barCheckEnabled } from '../bar-check.js';
import {
  SUBMISSION_PROOF_ENGINE,
  submissionProof,
} from '../submit-invariants.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  const barCheck = board && barCheckEnabled(board) ? BAR_CHECK_ENGINE : 1;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return Math.max(barCheck, RIGOR_AUTO_ENGINE);
  if (board && barReadySetting(board).enabled) return Math.max(barCheck, BAR_READY_ENGINE);
  if (args[0]?.landingFence !== undefined) return Math.max(barCheck, LANDING_LEASE_ENGINE);
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return Math.max(barCheck, BOARD_SENTINEL_ENGINE);
  if (args[1]?.submissionProof !== undefined) return Math.max(barCheck, SUBMISSION_PROOF_ENGINE);
  return barCheck;
}
/** Keep outside-source isolation as the original maximum over the older engine rule. */
function minimumEngine(args, board, at) {
  const outside = board && Boolean(outsideSource(board, args[0]));
  return Math.max(args[1]?.submissionSize !== undefined ? FLOW_SIZE_ENGINE : 1,
    outside ? OUTSIDE_INTAKE_ENGINE : 1, existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "submit", order: 15, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "A5_GRAMMAR_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "BAD_CONFIG": "fix pullboard.json as the message says, then commit it: git commit -m \"chore: fix pullboard config\" pullboard.json",
  "BAR_NOT_READY": "read pullboard bar <id>; ask its author to complete the named red baseline and measurement/edge notes, then have an outside parent session sign the current bar",
  "CHILDREN_OPEN": "finish the child items (pullboard list --all), or ask the coordinator to withdraw them",
  "CRITERIA_CHANGED": "ask the coordinator to refreeze it: pullboard shout coordinator \"please refreeze #<id>\"",
  "CRITERION_PROVES_NOTHING": "set a check that fails before the work: pullboard edit <id> --check \"<command>\", or ask the person to accept this one: pullboard check accept <id>",
  "DIRTY": "commit your changes, then run the command again",
  "GATE_RED": "fix what the gate report names, commit, and submit again",
  "GIT_GRAFTS": "ask the coordinator to remove the git graft file: pullboard shout coordinator \"please remove .git/info/grafts\"",
  "HEAD_NOT_NEW": "commit the rework, then pullboard submit <id>",
  "HOST_NAME": "reword the named commit's message without this machine's name (git rebase -i, then reword), then run pullboard submit <id> again",
  "INFRA_NOTE_REQUIRED": "run pullboard submit <id> --infra \"<why>\" with the reason the edit to an existing test or gate file is needed",
  "ITEM_LEASE_LOST": "read pullboard show <id>; if the item is free, claim it again for a build or reserve it with pullboard next --verify <id> for a review, then retry",
  "LAND_GATE_OUTPUT": "inspect the retained timed gate output directory and free disk space, then start another landing",
  "LAND_TIMEOUT_CUSTODY": "inspect the saved timed gate cleanup state and stop only its proven owned processes before starting another landing",
  "MAIN_NOT_COMPOSED": "merge current main into the candidate, commit the composition and submit again; for an unrecorded recovered move, run pullboard inbox first or ask the coordinator to resolve the pending receipt",
  "MERGE_CHECK_FAILED": "use Git 2.38 or newer (git --version), then retry",
  "MERGE_CONFLICT": "merge main into your branch, resolve the conflicts, commit, and run the command again",
  "MOVED_DURING_GATE": "leave the worktree alone until the gate finishes, then submit again",
  "NOT_A_REPO": "cd into a git repo, or make one: git init",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)",
  "NOT_YOURS": "shout its holder or the coordinator: pullboard shout coordinator \"<what you need>\"",
  "NO_COMMIT": "commit your work, or name a commit that exists: git log --oneline",
  "NO_CONFIG": "run pullboard init in the main checkout and commit pullboard.json",
  "NO_GATE": "in the main checkout, run pullboard gate set \"<project test command>\", then commit pullboard.json",
  "NO_ITEM": "find the item id: pullboard list --all",
  "NO_POLICY": "restore and commit pullboard.json, then run the command again",
  "NO_TRUNK": "in the main checkout, switch to the repository’s trunk branch and run pullboard inbox",
  "OUTSIDE_LANE": "move those changes out of this commit, and shout the lane that owns them: pullboard shout <lane> \"<text>\"",
  "PENDING_REFREEZE": "the coordinator runs pullboard refreeze <id>",
  "PIPEFAIL_UNAVAILABLE": "rewrite the gate in pullboard.json without a pipe",
  "RATCHET_ROSE": "fix the new doctrine problems named in the report, commit, and submit again; only the person can sign an increased count",
  "RATCHET_UNCOUNTED": "fix the named doctrine check to exit zero or one within its configured timeout, or ask the coordinator to repair it, then submit again",
  "RUNNER_BROWSER_SLOT_REQUIRED": "nothing to do: the run reruns on a local gate slot; if it repeats, set gate.browserByLaunch the same on this machine and that runner",
  "SESSION_LEDGER": "make the agent-session ledger named in the message writable by this user, then run the command again",
  "RUNNER_WAIT_DEADLINE": "check the runners the message names, or restore local gate capacity with pullboard settings, then retry",
  "SLOT_DB_LOCKED": "the run never started, so it is not a red; rerun the same command once the named process releases the slot database",
  "SPEC_BEHIND_MAIN": "git merge main",
  "STACKED_ON_UNVERIFIED": "wait for the earlier item to be accepted, or rebuild on main without its commits",
  "SUBMISSION_PROOF": "rerun pullboard submit <id> with the current CLI so its selected files and fallback are recorded",
  "TIMING_SLOT_REQUIRED": "start the timing check outside its inherited ordinary lease and acquire the machine gate with timing true",
  "UNTRACKED": "commit or ignore the untracked files, then run the command again",
  "USAGE": "run pullboard help"
}) });
