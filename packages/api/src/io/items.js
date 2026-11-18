/**
 * The item sets a board state is served in: open work first, finished items on demand (#6588). On a big board nine
 * items in ten are verified or withdrawn, which most screens never show, so a first load carries the rest and a screen
 * that shows finished items asks for them.
 */
import { createHash } from 'node:crypto';

/**
 * Whether an item is finished: withdrawn, or verified and landed. Why not every verified item: one accepted and waiting
 * to land still needs the person's eye, so it stays in the first state (#7795).
 */
const finished = (item) => item.status === 'withdrawn' || item.status === 'verified' && (item.stage === 'merged' || Boolean(item.merged));
/** The finished items' text, kept per board by the items' digest, so a build that finished nothing new reuses it. */
const kept = new Map();

/** Everything a summary leaves out, with the latest verdict whole: laid over its summary, it is the full item. `summaryKeys` is the items cell's SUMMARY_KEYS. */
export function itemDetail(item, summaryKeys) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => ['id', 'verdict', 'verdictState', 'withdrawnReason', 'withdrawnFrom'].includes(key) || !summaryKeys.has(key)));
}

/** The text the view's search matches for an item, lowercased: its #id, title, lane, spec ids and criterion. */
export function searchText(item) {
  return ('#' + item.id + ' ' + item.title + ' ' + item.lane + ' ' + item.specs.join(' ') + ' ' + (item.criterion || '')).toLowerCase();
}

/** How many items are verified and how many withdrawn: the counts an open-first state carries for the items it leaves out. */
export function finishedCounts(items) {
  return { verified: items.filter((item) => item.status === 'verified' && finished(item)).length, withdrawn: items.filter((item) => item.status === 'withdrawn').length };
}

/** A summary state with only its open, claimed and submitted items, naming what it left out in `itemsOmitted`. */
export function openOnly(summary) {
  return { ...summary, items: summary.items.filter((item) => !finished(item)), itemsOmitted: 'finished' };
}

/**
 * The finished items of a build as the reply of GET /boards/:id/finished: JSON text of {version: 1, sequence, state},
 * the state carrying them in the compact item encoding. Why kept by digest: encoding thousands of items is the costly
 * part, and a board's finished items change far less often than it builds.
 *
 * @param {{ cacheId: string, sequence: number, summary: { items: object[] } }} entry One cached board build.
 * @param {(state: object) => object} compactItemSummaries The view's compact encoder, a port.
 */
export function finishedText(entry, compactItemSummaries) {
  const items = entry.summary.items.filter(finished);
  const digest = createHash('sha1').update(JSON.stringify(items)).digest('hex');
  let held = kept.get(entry.cacheId);
  if (held?.digest !== digest) {
    held = { digest, state: JSON.stringify(compactItemSummaries({ items })) };
    kept.delete(entry.cacheId);
    kept.set(entry.cacheId, held);
    while (kept.size > 32) kept.delete(kept.keys().next().value);
  }
  return '{"version":1,"sequence":' + entry.sequence + ',"state":' + held.state + '}';
}

/**
 * One seat's lane, route and the ids it holds claimed, read from the agent and item rows alone, so a seat joined by URL
 * learns who it is without the host building the board state (#11052). A claim whose lease lapsed is not held.
 */
export function seatClaims(board, name, { store, Refused }) {
  const agent = board.db.prepare('SELECT agent_id, agent_lane, agent_route FROM agent WHERE agent_id=?').get(name);
  if (!agent) throw new Refused('NO_AGENT', `no registered agent ${name}; use the agents in this board's state or join a worktree first`);
  const claimed = board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner=? ORDER BY item_id").all(name)
    .filter((row) => store.isHeld(board, row)).map((row) => row.item_id);
  return { agent_id: agent.agent_id, agent_lane: agent.agent_lane, agent_route: agent.agent_route, claimed };
}
