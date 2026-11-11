import { TWO_TIER_DIAGNOSIS_ENGINE } from '../../../../state/light.js';
import { QUEUE_PREEMPT_ENGINE } from '../../../../state/light.js';
import { ITEM_NOTES_ENGINE } from "../../../../state/light.js";
import { ITEM_NOTE_KINDS } from "../../../../items/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by appendFact, discovered without a shared registry edit [C7,V4,H16]. */
import { CAUSE_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { IMPLIES_ENGINE } from "../../../../state/light.js";
import { carriesImplies } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { BAR_CHECK_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  const floor = Math.max(args[1]?.kind === 'diagnosis' ? TWO_TIER_DIAGNOSIS_ENGINE : 1, args[1]?.kind === 'urgent' ? QUEUE_PREEMPT_ENGINE : 1, ['bar-check', 'bar-answer'].includes(args[1]?.kind) ? BAR_CHECK_ENGINE : 1,
    ITEM_NOTE_KINDS.includes(args[1]?.kind) ? ITEM_NOTES_ENGINE : 1);
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return Math.max(floor, RIGOR_AUTO_ENGINE);
  if (args[0]?.landingFence !== undefined) return Math.max(floor, LANDING_LEASE_ENGINE);
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return Math.max(floor, BOARD_SENTINEL_ENGINE);
  if (['cause', 'neverAgain', 'asPerson'].some(name => Boolean(args[1] && typeof args[1] === 'object' && Object.hasOwn(args[1], name) && args[1][name] !== undefined && args[1][name] !== null && args[1][name] !== false))) return Math.max(floor, CAUSE_ENGINE);
  if (carriesImplies('appendFact', args)) return Math.max(floor, IMPLIES_ENGINE);
  return floor;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "appendFact", order: 40, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "BAD_FACT_ID": "upgrade to the current Pullboard engine, then retry the original fact operation",
  "BAD_FACT_KIND": "use a supported kind, such as note: pullboard fact <id> note \"<what you observed>\"",
  "EMPTY_FACT": "give nonempty fact text: pullboard fact <id> note \"<what you saw>\"",
  "FACT_INDEX_NOT_READY": "have the owning main checkout open this board once, then retry the original fact operation",
  "FACT_JUDGEMENT": "use a nonjudgement fact kind such as note, or ask the coordinator to record a judgement: pullboard fact <id> note \"<what you observed>\"",
  "NO_AGENT": "create and join a lane worktree: pullboard worktree <lane> --model \"<model name>\"",
  "NO_FACT": "name a fact id from pullboard show <id> --json"
}) });
