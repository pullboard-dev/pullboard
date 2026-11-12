import { seatFamily } from "../io/declaration.js";
import { itemWaits } from "../../../queue/index.js";
/**
 * pullboard queue (#797): the work queue agents pull from, top to bottom. Each unshipped release is a
 * breakpoint with its landed count, then its pullable items in the order next serves them, each with
 * its route, lane, status, holder and what it waits on; a closing line names the item each route would
 * get from next now. The order is the board's own buildOrder, never a second copy, so the queue and
 * next cannot disagree. Each item also shows its unblock count, effort and why it sits where it does (#1017).
 * It is for agents and coordinators; the person reads the Roadmap instead.
 */
import { Refused } from "../../../kernel/light.js";
import {
  milestoneRanks,
  queueReasons,
} from "./order/work.js";

/**
 * Who holds an item now: its builder while claimed, its reviewer while a submitted item is reserved.
 *
 * @param {any} item
 * @param {number} now
 * @returns {string | null}
 */
function holderOf(item, now) {
  if (item.item_status === 'claimed') return item.item_owner;
  if (item.item_status === 'submitted' && item.item_review_by && Date.parse(item.item_review_until) > now) return item.item_review_by;
  return null;
}

/**
 * The queue as one document: releases in roadmap order with their items in pull order, the work in
 * no release after them, and the first item each route would pull now.
 *
 * @param {any} board
 * @returns {{ releases: { name: string, landed: number, total: number, items: any[] }[], unreleased: any[], first: Record<string, number | null> }} each item with its unblocks, effort and why
 */
export function workQueue(board, ports, reviewer = null, options = {}, reads = board.nativePorts ?? ports) {
  const { buildOrder, canTake, listItems, milestonePriorities, milestones, roadmap, ROUTES, eligibilityProblem, foreignBlockers } = ports;
  const agent = reviewer ? board.db.prepare('SELECT agent_id,agent_route FROM agent WHERE agent_id=?').get(reviewer) : null;
  const now = board.clock.now().getTime();
  const release = milestonePriorities(board);
  const planned = roadmap(board, (reference) => ({ id: reference, title: reference, status: 'unavailable' }));
  const items = listItems(board).filter(item => !reviewer || item.item_status !== 'submitted' || agent && !eligibilityProblem(board, item, agent, options)).sort(buildOrder(board, { priority: release }));
  const inFlight = listItems(board, { all: true });
  const reasons = queueReasons(board, { priority: release, rank: milestoneRanks(board, release, { milestones }) }, { milestones, listItems, foreignBlockers });
  const entry = (item) => ({ id: item.item_id, title: item.item_title, route: item.item_route, lane: item.item_lane,
    status: item.item_status, holder: holderOf(item, now), waits: itemWaits(board, item, inFlight, foreignBlockers, reads), ...reasons(item) });
  const releases = planned.map((milestone, index) => ({ name: milestone.name, landed: milestone.landed, total: milestone.total, shipped: Boolean(milestone.shipped),
    items: items.filter((item) => release(item) === index).map(entry) })).filter((milestone) => !milestone.shipped || milestone.items.length);
  const unreleased = items.filter((item) => release(item) >= planned.length).map(entry);
  // next takes its own route first (B13), so each route's first item comes from that same order.
  const pullable = items.filter((item) => item.item_status === 'open' && !itemWaits(board, item, inFlight, foreignBlockers, reads).length).sort(buildOrder(board, { tierFirst: true, priority: release }));
  const first = Object.fromEntries([...ROUTES].reverse().map((route) => [route, pullable.find((item) => canTake(route, item.item_route))?.item_id ?? null]));
  return { releases: releases.map(({ shipped, ...milestone }) => milestone), unreleased, first };
}

/**
 * Print the queue: a breakpoint line per release, its items numbered in pull order, then the routes.
 *
 * @param {{ say: (text: string) => void }} io
 * @param {ReturnType<typeof workQueue>} queue
 */
export function sayQueue(io, queue) {
  let rank = 0;
  const line = (item) => {
    const who = item.holder ? ` · ${item.holder}` : '';
    io.say(`  ${++rank}. #${item.id} ${item.route} ${item.lane} ${item.status}${who}: ${item.title}`);
    io.say(`     unblocks ${item.unblocks} · effort ${item.effort} · ${item.why}`);
    if (item.waits.length) io.say(`     waits on ${item.waits.join('; ')}`);
  };
  for (const release of queue.releases) {
    io.say(`${release.name}: ${release.landed}/${release.total} landed`);
    release.items.forEach(line);
  }
  if (queue.unreleased.length) {
    io.say('in no release');
    queue.unreleased.forEach(line);
  }
  if (!queue.releases.length && !queue.unreleased.length) io.say('nothing in the queue');
  io.say(`next now: ${Object.entries(queue.first).map(([route, id]) => `${route} → ${id === null ? 'nothing' : `#${id}`}`).join(', ')}`);
}

/**
 * The pullboard queue command: no arguments; prints the queue and sets its JSON result.
 *
 * @param {any} io
 * @param {(string | undefined)[]} words
 * @param {(work: (board: any) => any) => any} read - opens the board for one read
 * @returns {number}
 */
export function queueCommand(io, words, read, ports, reviewer = () => null, options = {}) {
  if (words.some((word) => word !== undefined)) throw new Refused('USAGE', 'pullboard queue takes no arguments');
  const queue = read((board) => workQueue(board, ports, reviewer(board), options));
  io.result?.(queue);
  sayQueue(io, queue);
  return 0;
}
