import { REVIEW_REQUEST_ENGINE } from '../../../../state/light.js';
import { frozenBar } from '../../../../verify/browser.js';
import { namedClause } from '../../../../verify/browser.js';
import { wording } from '../../../../verify/browser.js';
import { REJECTION_RETURN_ENGINE } from '../../../../state/light.js';
import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../../state/light.js';
import { QUARANTINE_VERDICT_ENGINE } from "../../../../state/light.js";
import { checkTimingEngine } from "../../../../items/light.js";
import { REJECT_CLAUSE_ENGINE } from "../../../../state/light.js";
import { SOURCE_ADVANCE_ENGINE } from "../../../../state/light.js";
import { itemReviewPolicyEngine } from "../../../../verify/browser.js";
import { ITEM_PATCH_ENGINE } from "../../../../state/light.js";
import { requiredReviewFamilyEngine } from "../../../../verify/browser.js";
import { REVIEW_HEAD_BUILDER_FAMILY_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
import { LANDED_VERDICT_ENGINE } from "../../../../state/index.js";
/** Routing metadata owned by verify, discovered without a shared registry edit [C7,V4,H16]. */
import {
  CAUSE_ENGINE,
  REOPEN_FIRST_REFUSAL_ENGINE,
  VERDICT_REVIEW_ENGINE,
} from "../../../../state/light.js";
import { LANDING_ENVIRONMENT_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { IMPLIES_ENGINE } from "../../../../state/light.js";
import { carriesImplies } from "../../../../state/light.js";
import { OUTSIDE_INTAKE_ENGINE } from "../../../../state/light.js";
import { outsideSource } from "../../../../items/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[1]?.environment !== undefined) return LANDING_ENVIRONMENT_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (args[1]?.reopenFirstRefusalMinutes !== undefined) return REOPEN_FIRST_REFUSAL_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  if (args[1] && Object.hasOwn(args[1], 'review')) return VERDICT_REVIEW_ENGINE;
  if (['cause', 'neverAgain', 'asPerson'].some(name => Boolean(args[1] && typeof args[1] === 'object' && Object.hasOwn(args[1], name) && args[1][name] !== undefined && args[1][name] !== null && args[1][name] !== false))) return CAUSE_ENGINE;
  if (carriesImplies('verify', args)) return IMPLIES_ENGINE;
  return 1;
}
/** Keep outside-source isolation as the original maximum over the older engine rule. */
function minimumEngine(args, board, at) {
  const reservation = board?.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(args[0]);
  let relaxed = false;
  try { relaxed = JSON.parse(reservation?.event_detail ?? '{}').familyRelaxation?.version === 1; } catch { /* malformed events grant nothing */ }
  const item = board && typeof args[1]?.clause === 'string' ? board.db.prepare('SELECT item_frozen FROM item WHERE item_id=?').get(args[0]) : null;
  const quote = wording(args[1]?.clause);
  const bar = item && frozenBar(item, true);
  const checkClause = quote && bar && !namedClause(bar, quote) && namedClause(bar, quote, true);
  const sourceAdvance = args[1]?.sourceAdvanceHead !== undefined ? SOURCE_ADVANCE_ENGINE : 1;
  const outside = args[1]?.sandbox !== undefined || board && Boolean(outsideSource(board, args[0]));
  const patches = args[1]?.companionDigest !== undefined || board && board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`item_patches:${args[0]}`);
  return Math.max(args[1]?.landed === true ? LANDED_VERDICT_ENGINE : 1, checkClause ? REVIEW_REQUEST_ENGINE : 1, relaxed ? REVIEW_FAMILY_RELAX_ENGINE : 1, args[1]?.returnRejectedWork === true ? REJECTION_RETURN_ENGINE : 1, Object.hasOwn(args[1] ?? {}, 'quarantineProofId') ? QUARANTINE_VERDICT_ENGINE : 1, checkTimingEngine(board, args[0]), sourceAdvance, itemReviewPolicyEngine(board, args[0]), requiredReviewFamilyEngine(board, args[0]), patches ? Math.max(ITEM_PATCH_ENGINE, REVIEW_HEAD_BUILDER_FAMILY_ENGINE) : 1, outside ? OUTSIDE_INTAKE_ENGINE : 1, existingEngine(args, board, at),
    args[1] && Object.hasOwn(args[1], 'clause') ? REJECT_CLAUSE_ENGINE : 1);
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "verify", order: 18, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "TEST_SELECTION_SOURCE": "restore Git history and retry the selected test run",
  "TEST_TIER_MANIFEST": "regenerate and commit the testing tier manifest",
  "TEST_SELECTION_INCOMPLETE": "derive test selection from the complete committed diff",
  "TEST_SELECTION_UNVERIFIED": "make the focused runner execute and report the selected tests",

  "RUNNER_UNAVAILABLE": "inspect the unavailable runner and its exact cleanup generation; restore it before another attempt",
  "RUNNER_JOB_LOST": "inspect the exact runner and job named in the diagnostic; cleanup remains unknown until the pinned worker proves it, then retry",
  "REQUIRED_REVIEW_FAMILY": "ask a reviewer whose declared family matches the item review-family requirement",
  "STRICT_REVIEW_TOUCHED": "ask a session that has not written to this strict item",
  "RUNNER_WORK_SPEC": "upgrade or repair the controller and runner together, then retry the named invalid work specification",
  "RUNNER_LIFECYCLE_PROVIDER": "restart with the current installed controller so its canonical item lifecycle observer is composed",
  "RUNNER_BROWSER_SLOT_REQUIRED": "nothing to do: the run reruns on a local gate slot; if it repeats, set gate.browserByLaunch the same on this machine and that runner",
  "A5_GRAMMAR_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "ALREADY_MERGED": "file the follow-up as a new item: pullboard add <lane> \"<title>\"",
  "BAR_CLAUSE_REQUIRED": "add --clause \"exact wording from the frozen criterion or spec row\"",
  "BAR_CLAUSE_UNKNOWN": "read pullboard show <id>, then quote the failing requirement with --clause",
  "LINE_SETTING_RANGE": "read the allowed range with pullboard settings line, then record an in-range value or off with its reason and window numbers",
  "BAD_CAUSE": "name the cause as test:<file>::<title>, refusal:<CODE>, row:<id> or doctrine:<id>, or leave --cause out",
  "BAD_CONFIG": "fix pullboard.json as the message says, then commit it: git commit -m \"chore: fix pullboard config\" pullboard.json",
  "BAD_DECISION": "choose accept or reject with a supported reason: pullboard verify <id> reject --reason TEST_FAILURE --clause \"<frozen wording>\" --note \"<what failed>\"",
  "BAD_REASON": "accept with --note \"how you proved it\", or reject with --reason TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD or OTHER",
  "BAD_VERDICT_REVIEW": "restore the submitted commit and reviewed Git objects, then re-review the clean composition with current Pullboard",
  "CHECK_NO_PROOF": "strengthen the trusted criterion so it fails before the outside change, then ask the coordinator to refreeze it",
  "CHECK_RED": "reject with what failed: pullboard verify <id> reject --reason TEST_FAILURE --clause \"<frozen wording>\" --note \"<what failed>\"",
  "CHECK_UNVERIFIED": "restore the install or check environment, then run pullboard verify <id> again",
  "CLOSED": "read its state with pullboard show <id>, then take open work: pullboard next",
  "COORDINATOR_VERIFIES": "leave the review to the coordinator; record readiness on the item: pullboard fact <id> note \"ready for coordinator review\"",
  "CRITERIA_CHANGED": "ask the coordinator to refreeze it: pullboard shout coordinator --kind question \"please refreeze #<id>\"",
  "DIRTY": "commit your changes, then run the command again",
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "GIT_GRAFTS": "ask the coordinator to remove the git graft file: pullboard shout coordinator --kind question \"please remove .git/info/grafts\"",
  "GUARD_CANNOT_FAIL": "reject: the check does not test the guard; ask for one that fails with the guard reverted: pullboard verify <id> reject --reason TEST_FAILURE --clause \"<frozen wording>\" --note \"<what the check missed>\"",
  "GUARD_NOT_FOUND": "reject: the named guard is not in the submitted commit; fix the guard line in the criterion with the coordinator: pullboard shout coordinator --kind question --decision \"<id> guard does not match the commit\"",
  "ITEM_LEASE_LOST": "read pullboard show <id>; if the item is free, claim it again for a build or reserve it with pullboard next --verify <id> for a review, then retry",
  "LAND_HEADER": "shout the coordinator: pullboard shout coordinator --kind exception \"#<id> landing message fails its check\"",
  "MAIN_IS_COORDINATOR": "use an independent agent checkout for agent work, or run person-only actions from the main checkout as the coordinator",
  "MERGE_CHECK_FAILED": "use Git 2.38 or newer (git --version), then retry",
  "MERGE_CONFLICT": "merge main into your branch, resolve the conflicts, commit, and run the command again",
  "NOTE_REQUIRED": "add --note \"<what happened>\"",
  "NOT_AT_COMMIT": "check out the submitted commit shown by pullboard show <id>: git switch --detach <commit>",
  "NOT_A_REPO": "cd into a git repo, or make one: git init",
  "NOT_LANDED": "see its state with pullboard show <id>; only an item a forced merge landed with no verdict takes this accept",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)",
  "NOT_SUBMITTED": "see its state with pullboard show <id>; verify only submitted items: pullboard next --verify",
  "NOT_YOURS": "shout its holder or the coordinator: pullboard shout coordinator --kind question \"<what you need>\"",
  "NO_CONFIG": "run pullboard init in the main checkout and commit pullboard.json",
  "NO_ITEM": "find the item id: pullboard list --all",
  "NO_POLICY": "restore and commit pullboard.json, then run the command again",
  "NO_TRUNK": "in the main checkout, switch to the repository’s trunk branch and run pullboard inbox",
  "O2_FAMILY_MATCH": "ask the coordinator for a verifier from another family: pullboard shout coordinator --kind question \"#<id> needs a verifier from another family\"",
  "SAME_FAMILY": "ask the coordinator for a verifier from another family: pullboard shout coordinator --kind question \"#<id> needs a verifier from another family\"",
  "OUTSIDE_LANE": "move those changes out of this commit, and shout the lane that owns them: pullboard shout <lane> \"<text>\"",
  "OUTSIDE_SANDBOX_REQUIRED": "read the exact PR diff, then run pullboard verify <id> accept --sandbox with the configured container provider",
  "PROOF_REQUIRED": "say how you proved it: --note \"what you broke or which edge you tried, and what happened\"",
  "REVIEW_HELD": "take another review: pullboard next --verify",
  "ROUTE": "take an item your route covers: pullboard next",
  "SANDBOX_CHECK_REQUIRED": "set a trusted full gate and frozen causal criterion before intake",
  "SANDBOX_CLEANUP_REQUIRED": "restore Docker and remove the exact named owned container before another verification",
  "SANDBOX_EXECUTION": "restore the Docker daemon and inspect the named owned container before another verification",
  "SANDBOX_EXPORT": "restore Git access to the exact recorded commit and independent private export before verifying",
  "SANDBOX_IMAGE_REQUIRED": "preload the exact configured digest in the configured Docker daemon; verification does not pull automatically",
  "SANDBOX_PROVIDER_REQUIRED": "commit sandbox.provider docker with an absolute executable, explicit Unix endpoint and pinned minimum/current images in trusted main pullboard.json",
  "SANDBOX_RUNTIME": "correct the pinned official image so its actual Linux Node environment matches the configured minimum/current role",
  "SELF_SESSION_VERIFY": "start the review in a separate process or session: run pullboard next --verify from a different agent session's own worktree",
  "SELF_VERIFY": "ask a different agent to verify it; from main create its worktree with pullboard worktree <lane> --model \"<model name>\"",
  "SESSION_LEDGER": "make the agent-session ledger named in the message writable by this user, then run the command again",
  "RUNNER_WAIT_DEADLINE": "check the runners the message names, or restore local gate capacity with pullboard settings, then retry",
  "RUNNER_INFRA_RETRY_EXHAUSTED": "inspect the retained runner diagnostic, restore the named runner, then retry this command",
  "SLOT_DB_LOCKED": "the run never started, so it is not a red; rerun the same command once the named process releases the slot database",
  "STACKED_ON_UNVERIFIED": "rebuild on main without the unverified earlier commits, or take other work with pullboard next",
  "STALE_VERDICT": "merge current main into the submitted commit, commit a clean composition, then ask another agent to re-review it before landing",
  "TIMING_RUNNER_RESTRICTION": "adjust the runner restriction or gate.timingRunner setting named in the refusal, then retry submit",
  "TIMING_SLOT_REQUIRED": "start the timing check outside its inherited ordinary lease and acquire the machine gate with timing true",
  "UNTRACKED": "commit or ignore the untracked files, then run the command again",
  "VERDICT_ENVIRONMENT": "run the frozen check with current Pullboard, then have an independent reviewer record a fresh verdict with its actual executor environment",
  "VERDICT_TRUNK_MOVED": "merge the latest main into the submitted commit and ask another agent to re-review the clean composition",
  "VERIFIER_STANDING": "ask the coordinator to make an independent verifier from the main checkout: pullboard worktree <lane> --model \"<model name>\""
}) });
