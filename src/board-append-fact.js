import { requireFactKind } from './item-notes.js';
import { barCheckFactFields } from './bar-check.js';
import { PERSON } from './board-query.js';
import { isHeld } from './board-query.js';
import { current } from './board-query.js';
import { itemById } from './board-query.js';
import { itemThread } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { randomUUID } from 'node:crypto';
import { factIdentityExists } from './fact-identity.js';
import { requireFactIdentityIndexes } from './fact-identity.js';
import { COORDINATOR } from './config.js';
import { Refused } from './refused.js';
import { requireNeverAgain } from './board-rigor.js';
import { factReference } from './fact-reference.js';
import { factFromEvent } from '../packages/state/src/core/fact-projection.js';
import { tellFactImplications } from './implies.js';
import { postRigorNotices } from './board.js';

const FACT_JUDGEMENTS = new Set(['decision', 'rejection', 'supersession', 'root-cause']);

/** Append a typed fact atomically; a correction never edits the original event [B29,B30,B31,B32].
 * The internal factId is set from a sealed move's identity during replay, rather than replica-local sequence ids; a never-again with its cause is the person's alone, and rigor lists it at once (#713) [D1].
 */
export function appendFact(board, id, { agentId, kind, text, ref = null, supersedes = null, answers = null, factId = randomUUID(), implies, cause = null, neverAgain = false, asPerson = false, channel = 'terminal' }) {
  if (board.readOnly) requireFactIdentityIndexes(board.db);
  return atomic(board, () => {
    const item = current(board, itemById(board, id));
    if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(agentId)) throw new Refused('NO_AGENT', `no registered agent ${agentId}; join a worktree before appending a fact`);
    requireFactKind(board, kind);
    if (typeof text !== 'string' || !text.trim()) throw new Refused('EMPTY_FACT', 'a fact needs nonempty text; supply the observation or judgement');
    const barFields = barCheckFactFields(board, item, { agentId, kind, text, answers, supersedes });
    if ((FACT_JUDGEMENTS.has(kind) || supersedes !== null) && agentId !== COORDINATOR && (!isHeld(board, item) || item.item_owner !== agentId)) {
      throw new Refused('FACT_JUDGEMENT', `only the item's live holder${isHeld(board, item) ? ' (' + item.item_owner + ')' : ''} or the coordinator may append a judgement or supersede a fact; append an observation or ask the coordinator`);
    }
    if (typeof factId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(factId)) throw new Refused('BAD_FACT_ID', 'a fact identity is invalid; retry with the current Pullboard engine');
    if (factIdentityExists(board.db, factId)) throw new Refused('BAD_FACT_ID', 'this fact identity is already recorded; retry the original sealed move instead of appending it again');
    if (supersedes !== null && (typeof supersedes !== 'string' || !itemThread(board, id).some((entry) => entry.type === 'fact' && entry.id === supersedes))) {
      throw new Refused('NO_FACT', `no fact ${String(supersedes)} on item #${id}; use a fact id from pullboard show ${id} --json`);
    }
    const binding = factReference(ref);
    if (neverAgain || asPerson || cause !== null) requireNeverAgain(id, { agentId, cause, neverAgain, asPerson, channel });
    logEvent(board, neverAgain ? PERSON : agentId, 'fact', id, { id: factId, kind, text, ref: binding, supersedes, ...barFields, ...(neverAgain ? { cause, neverAgain: true, channel } : {}), ...(implies?.length ? { implies } : {}) });
    const trigger = board.lastEvent;
    const result = tellFactImplications(board, (by, itemId, fact) => logEvent(board, by, 'fact', itemId, fact), factFromEvent(trigger), { id, implies, supersedes });
    if (neverAgain) postRigorNotices(board, trigger);
    return result;
  });
}
