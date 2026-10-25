/** One durable request identity creates one normally claimable cross-lane child [B2,B5,B12]. */
import { createHash } from 'node:crypto';
import { itemById } from './board-query.js';
import { listAgents } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { ENGINE_VERSION } from './machine.js';
import { COMPANION_ENGINE } from './companion-engine.js';
import { Refused } from './refused.js';

/** Plan a request without writes; the same validation runs again inside its creation transaction. */
export function companionPlan(board, options, validateAddition) {
  const { agentId, parentId, lane, key, title = '', criterion = '', specIds = [], brief = '', route = 'strong', check, checkBaseline, barActor } = options;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < COMPANION_ENGINE) throw new Refused('ENGINE_VERSION', `companion requests require engine ${COMPANION_ENGINE}; upgrade Pullboard`);
  if (!listAgents(board).some(agent => agent.agent_id === agentId)) throw new Refused('NOT_JOINED', 'join this board before requesting companion work');
  if (!Number.isSafeInteger(parentId) || parentId < 1) throw new Refused('COMPANION_PARENT', 'name the parent item: pullboard companion <parent> <lane> "<title>" --key <key>');
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(key)) throw new Refused('COMPANION_KEY', 'supply a stable --key of 1 to 80 letters, digits, dots, underscores or hyphens; reuse it for this same companion');
  if (typeof lane !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(lane)) throw new Refused('NO_LANE', 'name the companion lane; see pullboard lanes');
  const parent = itemById(board, parentId);
  if (parent.item_lane === lane) throw new Refused('COMPANION_LANE', `the parent already belongs to ${lane}; request its companion in another lane`);
  const index = 'companion:' + createHash('sha256').update(JSON.stringify([parentId, lane, key])).digest('hex');
  const saved = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(index);
  if (saved) {
    const record = JSON.parse(saved.meta_value);
    const child = itemById(board, record.item);
    if (record.parentId !== parentId || record.lane !== lane || record.key !== key || child.item_parent_id !== parentId || child.item_lane !== lane) {
      throw new Refused('COMPANION_RECORD', 'the companion index does not match its child; restore a consistent board export before requesting it again');
    }
    return { existing: child.item_id };
  }
  if (!['open', 'claimed'].includes(parent.item_status)) throw new Refused('PARENT_CLOSED', `parent #${parentId} is ${parent.item_status}; reopen it before adding companion work`);
  if ([title, criterion, brief].some(value => typeof value !== 'string') || !Array.isArray(specIds) || specIds.some(id => typeof id !== 'string')) {
    throw new Refused('COMPANION_CONTENT', 'supply title, criterion and brief text, and a list of existing spec ids');
  }
  const item = { by: agentId, parentId, lane, title, criterion, specIds, brief, route, check, checkBaseline, barActor, after: [] };
  // Reuse every ordinary content/check guard; only this typed operation supplies a cross-lane parent.
  const validated = validateAddition(board, { ...item, parentId: null });
  return { item, validated, index, key };
}

/** Serialize the lookup, ordinary item insertion and durable request binding as one immediate move. */
export function applyCompanionRequest(board, options, { validateAddition, insertItem }) {
  return atomic(board, () => {
    const plan = companionPlan(board, options, validateAddition);
    if (plan.existing) return { item: plan.existing, created: false };
    const id = insertItem(board, plan.item, plan.validated);
    const { parentId, lane } = plan.item;
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)')
      .run(plan.index, JSON.stringify({ parentId, lane, key: plan.key, item: id }));
    logEvent(board, options.agentId, 'companion', parentId, { item: id, lane, key: plan.key });
    return { item: id, created: true };
  });
}
