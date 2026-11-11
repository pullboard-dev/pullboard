/** Opt-in queue ordering reads recorded board policy and the same review guards as actual reservation [N2,B13,H16]. */
import { localDependencyIds } from '../logic/references.js';
import { ENGINE_VERSION } from '../../../state/index.js';
import { LINE_ORDER_ENGINE } from '../../../state/light.js';
import { lineSettings } from '../../../state/light.js';

/** Old recorded moves retain their previous ordering even when replayed beside newer policy records. */
export function lineOrderEnabled(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= LINE_ORDER_ENGINE && lineSettings(board).order === true;
}

/** Construct one snapshot of downstream demand; closed and withdrawn followers cannot manufacture priority. */
export function waitedOnItems(items) {
  const wanted = new Set();
  for (const item of items) {
    if (['withdrawn', 'verified'].includes(item.item_status)) continue;
    for (const id of localDependencyIds(item)) wanted.add(id);
  }
  return wanted;
}

/**
 * Count potential reviewers through the actual reservation guards, rather than inventing a parallel lineage rule.
 * The store supplies its agent reader, so seat ordering never loads board queries.
 */
export function reviewerScarcity(board, items, eligible, { listAgents }) {
  const agents = listAgents(board);
  return new Map(items.map(item => [item.item_id, agents.filter(agent => eligible(item, agent.agent_id)).length]));
}

/** Order unfinished work by release, downstream demand, readiness and finally the coordinator's explicit rank. */
export function lineBuildOrder({ agentId, release, rank, items, ready = () => false, fallback }) {
  const wanted = waitedOnItems(items);
  /** A returned item still names the builder whose work must be finished before starting fresh work. */
  const returning = item => item.item_verdict === 'REJECT' && item.item_built_by === agentId;
  return (first, second) => Number(returning(second)) - Number(returning(first))
    || release(first) - release(second)
    || Number(wanted.has(second.item_id)) - Number(wanted.has(first.item_id))
    || Number(ready(second)) - Number(ready(first))
    || rank(first) - rank(second) || fallback(first, second);
}

/** Signed bar readiness is deliberately inert until #1110 supplies its authoritative predicate; no records are inferred. */
export function barReadyForOrder(_board, _item) { return false; }
