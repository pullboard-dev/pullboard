import { PIPELINE_CAUSE_ENGINE } from '../pipeline-cause-engine.js';
import { EXIT_RULES_ENGINE } from '../exit-rules-engine.js';
import { checkTimingEngine } from '../../packages/items/core.js';
import { CROSS_REPO_DEPENDENCY_ENGINE } from '../cross-repo-dependency-engine.js';
import { SUBMIT_ADMISSION_ENGINE } from '../submit-admission-engine.js';
import { hasForeignDependencies } from '../../packages/items/core.js';
import { AUTOMATIC_DISPATCH_ENGINE } from '../automatic-dispatch-engine.js';
import { LINE_CAPACITY_ENGINE } from '../line-capacity-engine.js';
import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by claim, discovered without a shared registry edit [C7,V4,H16]. */
import { BAR_READY_ENGINE } from '../bar-ready-engine.js';
import { barReadySetting } from '../bar-ready-setting.js';
import { firstRefusal } from '../board-item-read.js';
import { REOPEN_FIRST_REFUSAL_ENGINE } from '../engine-metadata.js';
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { OUTSIDE_INTAKE_ENGINE } from '../outside-intake-engine.js';
import { outsideSource } from '../../packages/items/core.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';
import { REWORK_SAME_FAMILY_ENGINE } from '../rework-same-family-engine.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (board && barReadySetting(board).enabled) return BAR_READY_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (board && firstRefusal(board, args[0], at)) return REOPEN_FIRST_REFUSAL_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}
/** Keep outside-source isolation as the original maximum over the older engine rule. */
function minimumEngine(args, board, at) {
  const outside = board && Boolean(outsideSource(board, args[0]));
  const capacity = args[1]?.lineCapacity === true;
  const id = args[0];
  const validId = ['number', 'string'].includes(typeof id) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
  const item = board && validId ? board.db.prepare('SELECT item_after FROM item WHERE item_id=?').get(id) : null;
  const foreign = item && hasForeignDependencies(item);
  return Math.max(args[1]?.submitOutcome != null ? PIPELINE_CAUSE_ENGINE : 1, args[1]?.exitRules?.enabled === true ? EXIT_RULES_ENGINE : 1, checkTimingEngine(board, args[0]), args[1]?.reworkSameFamily === true ? REWORK_SAME_FAMILY_ENGINE : 1, args[1]?.adoptCorrection === true ? AUTOMATIC_DISPATCH_ENGINE : 1, args[1]?.submitAdmission != null ? SUBMIT_ADMISSION_ENGINE : 1,
    foreign ? CROSS_REPO_DEPENDENCY_ENGINE : 1, outside ? OUTSIDE_INTAKE_ENGINE : 1, capacity ? LINE_CAPACITY_ENGINE : 1, existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "claim", order: 13, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "LINE_WIP_LIMIT": "review the oldest eligible waiting submission: pullboard next --verify; if none is eligible, ask the coordinator to arrange a reviewer",
  "A5_GRAMMAR_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "AGENT_APPROVAL_REQUIRED": "ask the person to confirm or decline the named row through pullboard view or their own terminal",
  "BAD_CONFIG": "fix pullboard.json as the message says, then commit it: git commit -m \"chore: fix pullboard config\" pullboard.json",
  "BAR_NOT_READY": "read pullboard bar <id>; ask its author to complete the named red baseline and measurement/edge notes, then have an outside parent session sign the current bar",
  "BLOCKED": "take another item with pullboard next, or shout the lane it waits on: pullboard shout <lane> \"<text>\"",
  "CRITERION_PROVES_NOTHING": "set a check that fails before the work: pullboard edit <id> --check \"<command>\", or ask the person to accept this one: pullboard check accept <id>",
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "HELD": "take another item: pullboard next",
  "ITEM_LEASE_LOST": "read pullboard show <id>; if the item is free, claim it again for a build or reserve it with pullboard next --verify <id> for a review, then retry",
  "ITEM_HELD": "take another item with pullboard next while the coordinator holds this one",
  "LANE_HELD": "wait for the lane: pullboard next --wait 9 (minutes)",
  "NOT_CLAIMABLE": "take open work: pullboard next",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)",
  "NO_ITEM": "find the item id: pullboard list --all",
  "NO_POLICY": "restore and commit pullboard.json, then run the command again",
  "ONE_CLAIM": "submit or release the item you hold: pullboard release <id> --reason <code> --note \"why\"",
  "PENDING_REFREEZE": "the coordinator runs pullboard refreeze <id>",
  "REOPEN_HELD_FOR_BUILDER": "wait until the named deadline, or ask the builder to run pullboard release <id> --reason ROUTED_ELSEWHERE",
  "ROUTE": "take an item your route covers: pullboard next",
  "SESSION_LEDGER": "make the agent-session ledger named in the message writable by this user, then run the command again",
  "UNKNOWN_SPEC": "ask the coordinator to restore the named spec rows or withdraw the item: pullboard shout coordinator --kind question \"please fix the rows cited by #<id>\"",
  "WRONG_LANE": "create a worktree in the required lane with pullboard worktree <lane> --model \"<model name>\", or take an item in your lane with pullboard next"
}) });
