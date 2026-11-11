/** Atomic replacement receipts on the ordinary board, independent of chat tools [B3,N19,H16]. */
import { HANDOFF_ENGINE } from "../../../state/index.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import { agentHandoff } from "../../../state/index.js";
import { itemHandoff } from "../../../state/index.js";
import { requireHandoffActive } from "../../../state/index.js";
import { Refused } from "../../../kernel/index.js";

/** Only a registered worktree seat can give up or take an agent's role. */
function worktreeAgent(board, id, agentById) {
  const agent = agentById(board, id);
  if (!agent || ['coordinator', 'person'].includes(id)) throw new Refused('HANDOFF_WORKTREE', 'run pullboard handoff from a joined agent worktree; the main checkout uses its separate coordinator takeover flow');
  return agent;
}

/** Refuse a leaf operation that the sender's replay engine cannot interpret. */
function requireHandoffEngine(board) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < HANDOFF_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard on every linked device before using pullboard handoff');
}

/** Find or create exactly one channel per outgoing seat under the same write lock. */
export function openHandoff(board, { agentId }, { atomic, addItem, agentById, logEvent }) {
  return atomic(board, () => {
    requireHandoffEngine(board);
    requireHandoffActive(board, agentId, 'openHandoff', []);
    const agent = worktreeAgent(board, agentId, agentById);
    const existing = agentHandoff(board, agentId);
    if (existing && !['verified', 'withdrawn'].includes(board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(existing.item).item_status)) return existing;
    const item = addItem(board, { by: agentId, lane: agent.agent_lane, route: 'strong', title: `Hand-off from ${agentId}`,
      criterion: 'The incoming agent reads the recorded hand-off and takes over.',
      brief: 'Record ownership, principles and taste, open threads, outside files and context only this agent knows. The incoming agent runs pullboard handoff --take <id>.' });
    logEvent(board, agentId, 'handoff-open', item, { engine: HANDOFF_ENGINE });
    return itemHandoff(board, item);
  });
}

/** First incoming seat wins atomically; repeating its own acknowledged takeover adds no fact. */
export function takeHandoff(board, { agentId, item }, { atomic, agentById, logEvent, appendFact }) {
  return atomic(board, () => {
    requireHandoffEngine(board);
    requireHandoffActive(board, agentId, 'takeHandoff', []);
    worktreeAgent(board, agentId, agentById);
    const handoff = itemHandoff(board, item);
    if (!handoff || ['verified', 'withdrawn'].includes(board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(item)?.item_status)) throw new Refused('NO_HANDOFF', `#${item} is not an agent hand-off; ask the outgoing agent to run pullboard handoff`);
    if (handoff.outgoing === agentId) throw new Refused('HANDOFF_SELF', 'the incoming agent takes the hand-off from its own new worktree: pullboard handoff --take <id>');
    if (handoff.incoming && handoff.incoming !== agentId) throw new Refused('HANDOFF_TAKEN', `#${item} was taken by ${handoff.incoming} at ${handoff.takenAt}; ask them on that item before replacing another role`);
    if (handoff.incoming) return handoff;
    const active = agentHandoff(board, handoff.outgoing);
    if (!active || active.item !== item || active.takenAt) throw new Refused('NO_HANDOFF', 'this is not the outgoing agent’s active hand-off; read its current hand-off before taking it');
    logEvent(board, agentId, 'handoff-take', item, { outgoing: handoff.outgoing, engine: HANDOFF_ENGINE });
    const taken = itemHandoff(board, item);
    appendFact(board, item, { agentId, kind: 'note', factId: `handoff-take-${item}`,
      text: `${agentId} took over from ${handoff.outgoing} at ${taken.takenAt}. The outgoing agent now only answers shouts on this hand-off item.` });
    return taken;
  });
}
