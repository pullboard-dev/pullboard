import { itemCheckBaseline } from './board-query.js';
export { itemCheckBaseline } from './board-query.js';
/** Baseline observations and their immutable completion fences [V2,H16]. */
import {
  atomic,
  itemById,
  logEvent,
} from './board.js';
import { COORDINATOR } from './config.js';
import { Refused } from './refused.js';

/** Normalize an explicitly supplied check only when its author is the coordinator [V2]. */
export function coordinatorCheck(agentId, command) {
  if (command === undefined) return undefined;
  if (agentId !== COORDINATOR) {
    throw new Refused('COORDINATOR_CHECK', 'only the coordinator sets or edits an item check; ask your coordinator to supply --check');
  }
  if (typeof command !== 'string') throw new Refused('BAD_CHECK', 'an item check is a command string; ask your coordinator to supply --check "<command>"');
  return command.trim();
}

/** Validate captured baseline data without asking a replica to run Git or a shell [V2,H16]. */
export function normalizeCheckBaseline(agentId, command, baseline, { authorized = false } = {}) {
  if (baseline === undefined) return undefined;
  coordinatorCheck(authorized ? COORDINATOR : agentId, command ?? '');
  if (!command || !baseline || typeof baseline !== 'object' || Array.isArray(baseline)
    || baseline.command !== command || !['green', 'red', 'unavailable', 'pending'].includes(baseline.result)
    || !(baseline.main === null || typeof baseline.main === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline.main))
    || (baseline.result !== 'unavailable' && baseline.main === null)
    || (baseline.result === 'pending' && !baseline.request)
    || (baseline.request !== undefined && (typeof baseline.request !== 'string' || !/^[a-f0-9-]{36}$/.test(baseline.request)))
    || (baseline.reason !== undefined && typeof baseline.reason !== 'string')
    || (baseline.testEvidence !== undefined && (!baseline.testEvidence || typeof baseline.testEvidence.noTestsMatched !== 'boolean'
      || !['failed','passed'].every(key => Array.isArray(baseline.testEvidence[key]) && baseline.testEvidence[key].length <= 512 && baseline.testEvidence[key].every(name => typeof name === 'string' && name.length <= 4096))))
    || (baseline.seconds !== undefined && (!Number.isSafeInteger(baseline.seconds) || baseline.seconds < 0))) {
    throw new Refused('BAD_CHECK_BASELINE', 'the check baseline must describe this command at a main commit; set --check again from the coordinator');
  }
  return {
    command, main: baseline.main, result: baseline.result,
    ...(baseline.request === undefined ? {} : { request: baseline.request }),
    ...(baseline.reason === undefined ? {} : { reason: baseline.reason }),
    ...(baseline.testEvidence === undefined ? {} : { testEvidence: { failed: [...baseline.testEvidence.failed], passed: [...baseline.testEvidence.passed], noTestsMatched: baseline.testEvidence.noTestsMatched } }),
    ...(baseline.seconds === undefined ? {} : { seconds: baseline.seconds }),
    ...(baseline.result === 'green' ? { warning: 'CRITERION_PROVES_NOTHING' } : {}),
  };
}

/** Record a captured result only for the still-current authorized background request [V2,H16]. */
export function completeCheckBaseline(board, id, { agentId, expected, baseline }) {
  return atomic(board, () => {
    const result = normalizeCheckBaseline(agentId, baseline?.command, baseline);
    if (!expected || !result || result.result === 'pending' || result.command !== expected.command || result.main !== expected.main
      || typeof expected.request !== 'string' || !/^[a-f0-9-]{36}$/.test(expected.request)) {
      throw new Refused('BAD_CHECK_BASELINE', 'a completed baseline must match its authorized request; set --check again from the coordinator');
    }
    const item = itemById(board, id);
    const current = itemCheckBaseline(board, item);
    if (current?.result !== 'pending' || current.request !== expected.request || current.command !== expected.command || current.main !== expected.main) return false;
    const recorded = { ...result, request: expected.request };
    saveCheckBaseline(board, id, recorded);
    logEvent(board, agentId, 'check-baseline', id, { checkBaseline: recorded });
    return true;
  });
}

/** Store or clear an item's observation atomically with its check and immutable audit event. */
export function saveCheckBaseline(board, id, baseline) {
  const key = `item_check_baseline_${id}`;
  if (!baseline) board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run(key);
  else board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(key, JSON.stringify(baseline));
}

/** Read the current check's setter from immutable edits, or its original item author [V2]. */
export function itemCheckAuthor(board, id) {
  const item = itemById(board, id);
  const edits = board.db.prepare("SELECT event_by, event_detail FROM event WHERE item_id = ? AND event_kind = 'edit' ORDER BY event_id DESC").all(id);
  for (const edit of edits) {
    let detail;
    try { detail = JSON.parse(edit.event_detail); }
    catch { return null; }
    if (detail && Object.hasOwn(detail, 'check')) return detail.check === item.item_check ? edit.event_by : null;
  }
  return item.item_created_by;
}
