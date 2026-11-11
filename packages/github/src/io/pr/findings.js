/** Preserve merged history while recording one linked neutral CI repair [B2,R3]. */
import { createHash } from 'node:crypto';
import {
  addItem,
  appendFact,
  atomic,
  getItem,
  linkPublishRepair,
  logEvent,
} from '../../../../store/index.js';
import { COORDINATOR } from '../../../../config/index.js';
import { Refused } from '../../../../kernel/index.js';

/** Require bounded provider identities; strings become observations, never commands. */
function line(value, limit = 500) { return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\r\n\0]/u.test(value); }

/** Atomically append the observed finding and create its repair without relaxing ordinary child/reopen guards. */
export function recordPublishFinding(board, { agentId, item, repository, pull, head, failures }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator records publication CI findings');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '') || repository.split('/').some(part => ['.', '..'].includes(part)) || !Number.isSafeInteger(pull) || pull < 1 ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head ?? '') || !Array.isArray(failures) || failures.length < 1 || failures.length > 100 ||
      failures.some(f => !Number.isSafeInteger(f.id) || f.id < 1 || !line(f.name) || !line(f.url, 2000) ||
        !Array.isArray(f.files) || !f.files.length || f.files.length > 500 || f.files.some(file => !line(file, 4096) || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')))) {
    throw new Refused('PUBLISH_FINDING', 'record exact repository, PR head, failing job/run and implicated repository-relative files');
  }
  const key = createHash('sha256').update(JSON.stringify([repository, pull, head, item])).digest('hex');
  return atomic(board, () => {
    const original = getItem(board, item);
    if (!original.item_merged_commit || original.item_status !== 'verified') throw new Refused('PUBLISH_FINDING', 'CI findings here must name an already merged item; preserve ordinary item review for unmerged work.');
    const old = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='pr-ci-finding' AND item_id=? ORDER BY event_id DESC").all(item)
      .map(row => JSON.parse(row.event_detail)).find(detail => detail.key === key);
    const observed = [...(old?.failures ?? [])];
    for (const failure of failures) if (!observed.some(f => f.id === failure.id && f.name === failure.name)) observed.push(failure);
    if (old && observed.length === old.failures.length) return old;
    const repair = old?.repair ?? addItem(board, { by: agentId, lane: original.item_lane, route: 'strong',
      title: `CI finding for #${item}: ${failures[0].name.slice(0, 100)}`,
      criterion: `The publication head passes the reported CI jobs: ${failures.map(f => f.name).join('; ')}. Diagnose the finding without assuming its item or test is flaky.`,
      brief: `Linked repair of merged item #${item}; GitHub ${repository} PR #${pull}, head ${head}. Keep the original merge and acceptance history. Jobs: ${failures.map(f => `${f.name}: ${f.url}`).join('; ')}` });
    // This new coordinator-only move is the explicit exception for a repair OF a closed item.
    // The ordinary addItem(parentId) guard still refuses a child of any closed parent.
    if (!old) linkPublishRepair(board, { agentId, item, repair });
    const detail = { key, repository, pull, head, item, repair, failures: observed };
    const factId = 'pr-ci-' + createHash('sha256').update(JSON.stringify(detail)).digest('hex');
    appendFact(board, item, { agentId, kind: 'capture', factId, text: 'CI finding: ' + JSON.stringify(detail) });
    logEvent(board, agentId, 'pr-ci-finding', item, detail);
    return detail;
  });
}
