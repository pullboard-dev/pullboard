/** Preserve proved foreign paths for their owner without submitting or accepting them [B3,L1,V4]. */
import { Refused } from '../../../../kernel/index.js';
import {
  OWNERSHIP_WAIT_ENGINE,
  ENGINE_VERSION,
} from '../../../../state/index.js';
import {
  atomic,
  logEvent,
} from './event/log.js';
import {
  itemById,
  proofReceipts,
} from './query.js';
import { release } from './release.js';
import { setItem } from '../board.js';
import { insertShout } from './shout.js';

const PREFIX = 'ownership_wait:';

/** Read one current owner wait; an unhold, changed criterion or completed item retires its projection. */
export function ownershipWait(board, id) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(PREFIX + id);
  if (!row) return null;
  let wait;
  try { wait = JSON.parse(row.meta_value); } catch { return null; }
  const item = itemById(board, id);
  return item.item_status === 'open' && item.item_hold_reason === `waiting on ownership ${wait.key}`
    && item.item_frozen_digest === wait.digest ? wait : null;
}

/** Keep completion bound to its private native job even if the owner acts before the worker replies. */
export function ownershipWaitForJob(board, job) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('ownership_wait_job:' + job);
  return row ? JSON.parse(row.meta_value) : null;
}

/** List only the requested owner's native queue, leaving archival source receipts intact. */
export function ownershipWaiting(board, owner) {
  const rows = board.db.prepare('SELECT meta_key FROM board_meta WHERE meta_key GLOB ? ORDER BY meta_key').all(PREFIX + '*');
  return rows.map(row => Number(row.meta_key.slice(PREFIX.length))).filter(Number.isSafeInteger)
    .map(id => ownershipWait(board, id)).filter(wait => wait?.owners?.includes(owner))
    .map(({ receipts, job: _job, ...wait }) => ({ ...wait, receiptIds: receipts.map(receipt => receipt.id) }));
}

/** Require actual canonical submit receipts at the exact source, with no known red, waiver or source advance. */
function greenOwnershipProof(board, id, item, wait) {
  const known = new Map(proofReceipts(board, id).map(receipt => [receipt.id, receipt]));
  const receipts = wait.receipts;
  if (!Array.isArray(receipts) || !receipts.length || receipts.some(receipt => {
    const proof = receipt?.proof, recorded = known.get(receipt?.id);
    return !recorded || recorded.kind !== 'submit' || recorded.commit !== wait.commit || recorded.tree !== wait.tree
      || recorded.item !== id || recorded.seat !== wait.agentId || recorded.frozenDigest !== item.item_frozen_digest
      || recorded.exitCode !== 0 || recorded.sourceClean !== true || recorded.green === false
      || recorded.counts?.failed > 0 || Array.isArray(recorded.failures) && recorded.failures.length > 0
      || JSON.stringify(recorded.counts) !== JSON.stringify(proof?.counts)
      || recorded.at !== receipt?.at || recorded.durationMs !== proof?.durationMs
      || recorded.submitPhase !== proof?.submitPhase || recorded.command !== undefined && recorded.command !== receipt?.command
      || receipt?.version !== 2 || !known.has(receipt.id) || receipt.kind !== 'submit' || receipt.green !== true
      || receipt.head !== wait.commit || receipt.tree !== wait.tree || receipt.main !== null && receipt.main !== wait.main
      || !Array.isArray(receipt.failures) || receipt.failures.length
      || proof?.item !== id || proof.seat !== wait.agentId || proof.frozenDigest !== item.item_frozen_digest
      || proof.sourceClean !== true || proof.exitCode !== 0;
  })) throw new Refused('OWNERSHIP_WAIT_PROOF', 'ownership routing needs recorded native green submit receipts for this exact source and frozen criterion');
  // Legacy full profiles bind one native receipt; do not invent extra phase receipts or a main pass.
}

/** Atomically free the builder, hold the item for its owners, and notify each once for this immutable source. */
export function deferOwnership(board, id, request) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < OWNERSHIP_WAIT_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade every linked writer before routing owner waits');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Refused('OWNERSHIP_WAIT_INVALID', 'supply the original source and native receipts for the current builder');
  const previous = ownershipWait(board, id);
  if (board.executionEngineVersion === undefined && request.key && previous?.key === request.key
    && previous.agentId === request.agentId && previous.commit === request.commit && previous.tree === request.tree
    && previous.main === request.main) return previous;
  if (board.executionEngineVersion === undefined && typeof board.enginePorts.sealOwnershipWait !== 'function') {
    throw new Refused('NO_POLICY', 'open the writable native board before routing owner waits');
  }
  const wait = board.executionEngineVersion === undefined ? board.enginePorts.sealOwnershipWait(board, id, request) : request;
  return atomic(board, () => {
    const item = itemById(board, id), previous = ownershipWait(board, id);
    if (previous?.key === wait.key && previous.agentId === wait.agentId) return previous;
    if (item.item_status !== 'claimed' || item.item_owner !== wait.agentId || item.item_hold_reason || !(item.item_lease_until > board.clock.now().toISOString())
      || wait?.version !== 1 || wait.item !== id || wait.digest !== item.item_frozen_digest
      || !Array.isArray(wait.paths) || !wait.paths.length || !Array.isArray(wait.owners) || !wait.owners.length
      || typeof wait.diff !== 'string' || !wait.diff || !/^[a-f0-9]{64}$/u.test(wait.key ?? '')) {
      throw new Refused('OWNERSHIP_WAIT_INVALID', 'only the current builder can route its exact frozen, proved source to its owners');
    }
    greenOwnershipProof(board, id, item, wait);
    release(board, id, wait.agentId, `Green checks await ownership of ${wait.paths.join(', ')}`, undefined, 'ROUTED_ELSEWHERE');
    setItem(board, id, { item_hold_reason: `waiting on ownership ${wait.key}`, item_hold_by: 'coordinator', item_hold_at: board.clock.now().toISOString() });
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run(PREFIX + id, JSON.stringify(wait));
    if (wait.job) board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run('ownership_wait_job:' + wait.job, JSON.stringify(wait));
    const { job: _job, ...publicWait } = wait;
    logEvent(board, wait.agentId, 'ownership-wait', id, publicWait);
    for (const owner of wait.owners) insertShout(board, { from: wait.agentId, to: owner, lanes: wait.lanes,
      text: `#${id} waits on ${owner} ownership. Paths: ${wait.paths.join(', ')}\nSource: ${wait.commit} (${wait.sourceRef})\nExact diff:\n${wait.diff}End of diff.`,
      detail: { item: id, ownershipWait: wait.key } });
    return wait;
  });
}
