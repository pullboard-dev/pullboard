import { localDependencyIds } from "../dependencies.js";
/**
 * The queue orders itself (#1017) [N22,B13]. Within each release, an item's unblock count (unfinished items that
 * wait on it, directly or through others) and effort (its route: light 1, mid 2, strong 3) give a score of
 * (unblocks + 1) / effort. Ready items that unblock others alternate with quick wins (light or mid, unblocking
 * nothing) at the top; the rest of the ready work follows by score so effort levels stay mixed; every route with
 * ready work gets an item near the top; blocked items follow in the order their blockers clear, and held items
 * last. The coordinator's pins sit above that order and its sinks below it, each with its reason, until lifted.
 *
 * Pure reads over the board, so pullboard queue, next and health share one order. Recorded moves below
 * WORK_ORDER_ENGINE keep their old milestone, rank, route and age order.
 */
import { engineAtLeast } from "../../../../state/light.js";
import { MILESTONE_RANK_ENGINE } from "../../../../state/light.js";
import { WORK_ORDER_ENGINE } from "../../../../state/light.js";
import { ROUTES } from "../../../../seats/browser.js";

/** Effort per route: what one item of that route costs to build. */
export const EFFORT = Object.freeze({ light: 1, mid: 2, strong: 3 });

/** Explicit item ranks belong to the same first unfinished milestone as its priority [N2,B13]. */
export function milestoneRanks(board, priority, { milestones }) {
  if (!engineAtLeast(board, MILESTONE_RANK_ENGINE)) return () => 0;
  const ranks = new Map();
  for (const [index, milestone] of milestones(board).entries()) {
    for (const [rank, id] of (milestone.order ?? []).entries()) {
      if (milestone.items.includes(id) && priority({ item_id: id }) === index && !ranks.has(id)) ranks.set(id, rank);
    }
  }
  return entry => ranks.get(entry.item_id) ?? Number.MAX_SAFE_INTEGER;
}

/** True when this board's moves run at or above the self-ordering engine. */
export function workOrderActive(board) {
  return engineAtLeast(board, WORK_ORDER_ENGINE);
}

/** The item numbers an item waits on, as recorded. */
function afterIds(item) {
  return localDependencyIds(item);
}

/**
 * The coordinator's overrides for each item in the first unfinished milestone that lists it: its pin reason or
 * its sink reason. A pin with no reason is an older milestone order.
 *
 * @param {any} board
 * @param {(entry: any) => number} priority
 * @returns {{ sunk: Set<number>, reasons: Map<number, string> }}
 */
export function milestoneOverrides(board, priority, { milestones }) {
  const sunk = new Set();
  const reasons = new Map();
  for (const [index, milestone] of milestones(board).entries()) {
    for (const id of milestone.sunk ?? []) if (priority({ item_id: id }) === index) sunk.add(id);
    for (const [id, reason] of Object.entries(milestone.reasons ?? {})) if (priority({ item_id: Number(id) }) === index && !reasons.has(Number(id))) reasons.set(Number(id), reason);
  }
  return { sunk, reasons };
}

/**
 * Each unfinished item's unblock count: the unfinished items that wait on it, directly or through others.
 *
 * @param {any[]} unfinished
 * @returns {Map<number, number>}
 */
export function unblockCounts(unfinished) {
  const waiters = new Map();
  for (const item of unfinished) for (const id of afterIds(item)) waiters.set(id, [...(waiters.get(id) ?? []), item.item_id]);
  const counts = new Map();
  for (const item of unfinished) {
    const seen = new Set();
    const stack = [...(waiters.get(item.item_id) ?? [])];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || id === item.item_id) continue;
      seen.add(id);
      stack.push(...(waiters.get(id) ?? []));
    }
    counts.set(item.item_id, seen.size);
  }
  return counts;
}

/**
 * How many blockers deep an item sits: 0 when everything it waits on is verified, as next requires. A withdrawn
 * blocker never clears, so it counts as one level. A cycle counts once.
 *
 * @param {Map<number, any>} open unfinished items by id
 * @param {Set<number>} withdrawn
 * @returns {(item: any) => number}
 */
function blockerDepth(board, open, withdrawn, foreignBlockers) {
  const depths = new Map();
  const depth = (item, visiting = new Set()) => {
    if (depths.has(item.item_id)) return depths.get(item.item_id);
    if (visiting.has(item.item_id)) return 0;
    visiting.add(item.item_id);
    const blockers = afterIds(item).map((id) => open.get(id)).filter(Boolean);
    const never = foreignBlockers(board, item).length > 0 || afterIds(item).some((id) => withdrawn.has(id));
    const value = blockers.length || never ? 1 + Math.max(0, ...blockers.map((blocker) => depth(blocker, visiting))) : 0;
    depths.set(item.item_id, value);
    return value;
  };
  return (item) => depth(item);
}

/** Interleave unblockers and quick wins while both last; the rest of the ready work follows by score. */
function readySequence(ready, byScore) {
  const unblockers = ready.filter((entry) => entry.unblocks > 0).sort(byScore);
  const quick = ready.filter((entry) => entry.unblocks === 0 && entry.item.item_route !== 'strong').sort(byScore);
  const zipped = [];
  const pairs = Math.min(unblockers.length, quick.length);
  for (let index = 0; index < pairs; index++) zipped.push(unblockers[index], quick[index]);
  const rest = ready.filter((entry) => !zipped.includes(entry)).sort(byScore);
  return routesNearTop([...zipped, ...rest]);
}

/** Lift each route's best ready item into the top, so no route with ready work waits behind the others. */
function routesNearTop(sequence) {
  const routes = [...new Set(sequence.map((entry) => entry.item.item_route))];
  const head = sequence.slice(0, routes.length);
  for (const route of routes) {
    if (head.some((entry) => entry.item.item_route === route)) continue;
    head.push(sequence.find((entry) => entry.item.item_route === route));
  }
  return [...head, ...sequence.filter((entry) => !head.includes(entry))];
}

/** Why an item sits where it does, in the queue's words. */
function whyOf(entry) {
  if (entry.kind === 'held') return 'held by the coordinator';
  if (entry.kind === 'blocked') return `blocked: ${entry.depth === 1 ? 'rises when its blocker lands' : `${entry.depth} blockers deep`}`;
  if (entry.unblocks > 0) return `ready and unblocks ${entry.unblocks}`;
  if (entry.item.item_route !== 'strong') return 'ready quick win';
  return 'ready work by score';
}

/**
 * The computed order of every unfinished item, release by release.
 *
 * @param {any} board
 * @param {{ priority: (entry: any) => number, shared?: (entry: any) => number, tieBreak?: (first: any, second: any) => number }} options
 * @returns {Map<number, { position: number, unblocks: number, effort: number, score: number, why: string }>}
 */
export function computedOrder(board, { priority, shared = () => 0, tieBreak = () => 0 }, { listItems, foreignBlockers }) {
  // Only unfinished items and withdrawn ids matter, so a large board's finished history is never read.
  const unfinished = listItems(board);
  const withdrawn = new Set(board.db.prepare("SELECT item_id FROM item WHERE item_status = 'withdrawn'").all().map((row) => row.item_id));
  const counts = unblockCounts(unfinished);
  const depthOf = blockerDepth(board, new Map(unfinished.map((item) => [item.item_id, item])), withdrawn, foreignBlockers);
  const entries = unfinished.map((item) => {
    const unblocks = counts.get(item.item_id) ?? 0;
    const effort = EFFORT[item.item_route] ?? EFFORT.strong;
    const depth = depthOf(item);
    return { item, unblocks, effort, score: (unblocks + 1) / effort, depth,
      kind: item.item_hold_reason ? 'held' : depth ? 'blocked' : 'ready', release: priority(item) };
  });
  const byScore = (first, second) => second.score - first.score || tieBreak(first.item, second.item) || shared(second.item) - shared(first.item) || first.item.item_id - second.item.item_id;
  const order = new Map();
  for (const release of [...new Set(entries.map((entry) => entry.release))].sort((a, b) => a - b)) {
    const group = entries.filter((entry) => entry.release === release);
    const blocked = group.filter((entry) => entry.kind === 'blocked').sort((first, second) => first.depth - second.depth || byScore(first, second));
    const held = group.filter((entry) => entry.kind === 'held').sort(byScore);
    [...readySequence(group.filter((entry) => entry.kind === 'ready'), byScore), ...blocked, ...held].forEach((entry, position) => {
      order.set(entry.item.item_id, { position, unblocks: entry.unblocks, effort: entry.effort, score: entry.score, why: whyOf(entry) });
    });
  }
  return order;
}

/**
 * The self-ordering comparator for buildOrder: release, coordinator pin, coordinator sink, then the computed
 * order. With `tierFirst`, next's own route comes before the computed order, so an agent claims its tier first
 * (B13). Null below WORK_ORDER_ENGINE, where buildOrder keeps its recorded order.
 *
 * @param {any} board
 * @param {{ priority: (entry: any) => number, rank: (entry: any) => number, shared: (entry: any) => number, tierFirst?: boolean, tieBreak?: (first: any, second: any) => number }} options
 * @returns {((first: any, second: any) => number) | null}
 */
export function workOrderCompare(board, { priority, rank, shared, tierFirst = false, tieBreak = () => 0 }, ports) {
  if (!workOrderActive(board)) return null;
  const order = computedOrder(board, { priority, shared, tieBreak }, ports);
  const { sunk } = milestoneOverrides(board, priority, ports);
  const position = (entry) => order.get(entry.item_id)?.position ?? Number.MAX_SAFE_INTEGER;
  return (first, second) => priority(first) - priority(second)
    || rank(first) - rank(second)
    || Number(sunk.has(first.item_id)) - Number(sunk.has(second.item_id))
    || (tierFirst ? ROUTES.indexOf(second.item_route) - ROUTES.indexOf(first.item_route) : 0)
    || position(first) - position(second)
    || first.item_id - second.item_id;
}

/**
 * Each item's place in the queue as pullable work explains it: unblock count, effort and why it sits there.
 *
 * @param {any} board
 * @param {{ priority: (entry: any) => number, rank: (entry: any) => number }} options
 * @returns {(item: any) => { unblocks: number, effort: number, why: string }}
 */
export function queueReasons(board, { priority, rank }, ports) {
  const order = computedOrder(board, { priority }, ports);
  const { sunk, reasons } = milestoneOverrides(board, priority, ports);
  return (item) => {
    const computed = order.get(item.item_id) ?? { unblocks: 0, effort: EFFORT[item.item_route] ?? EFFORT.strong, why: 'finished' };
    const reason = reasons.get(item.item_id);
    const why = rank(item) !== Number.MAX_SAFE_INTEGER ? `pinned by the coordinator: ${reason ?? 'milestone order'}`
      : sunk.has(item.item_id) ? `sunk by the coordinator: ${reason ?? 'no reason recorded'}` : computed.why;
    return { unblocks: computed.unblocks, effort: computed.effort, why };
  };
}
