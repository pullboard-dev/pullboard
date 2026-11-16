/**
 * The board's shared counts: agents at work, runners, rulings and sent back, one function each (#7310).
 * Why: every page used to count these itself, so the top bar, Dashboard and Activity could show different numbers at
 * the same moment. The state read builds them once, as `counts`, and every page reads that value.
 */
import { staleChip } from './stale.js';

/** The verdict kinds that send an item back to its builder: a review's reject, or a reopen after it was accepted. */
export const SENT_BACK_KINDS = Object.freeze(['reject', 'reopen']);

/** The hour an agent stays "at work" after its last move while its work waits on someone else. */
const RECENT_MS = 3_600_000;

/**
 * The agents at work, by id: whoever holds a claim or reviews a submission, and whoever built an item that is sent
 * back or waiting on review if it moved in the last hour.
 *
 * @param {{ items?: any[], agents?: any[] }} project - The board state: items and agents (each with lastMoveAt).
 * @param {number} now - The state's clock in milliseconds.
 * @returns {string[]}
 */
export function agentsAtWork(project, now) {
  const working = new Set(), sure = new Set();
  for (const item of project.items ?? []) {
    if (item.status === 'withdrawn') continue;
    if (item.status === 'claimed') {
      const holder = item.claim?.by ?? item.owner ?? null;
      if (holder) { working.add(holder); sure.add(holder); }
      continue;
    }
    const reviewer = item.status === 'submitted' ? item.claim?.by ?? item.reviewer ?? null : null;
    if (reviewer) { working.add(reviewer); sure.add(reviewer); }
    const back = !['submitted', 'verified'].includes(item.status) && item.verdict?.decision === 'REJECT';
    if (item.builtBy && (back || item.status === 'submitted' || staleChip(item))) working.add(item.builtBy);
  }
  return (project.agents ?? []).filter(agent => working.has(agent.agent_id)
    && (sure.has(agent.agent_id) || (agent.lastMoveAt && now - Date.parse(agent.lastMoveAt) < RECENT_MS))).map(agent => agent.agent_id);
}

/**
 * The runners reporting to this board: the rows of the Dashboard's runner card, or 0 when none reports.
 *
 * @param {{ dashboardRunners?: { runners?: any[] } | null }} project
 * @returns {number}
 */
export function runnersReporting(project) {
  return Array.isArray(project.dashboardRunners?.runners) ? project.dashboardRunners.runners.length : 0;
}

/**
 * The rulings: the calls only the person can make, the list the top bar's Rulings opens.
 *
 * @param {{ needs?: any[] }} project
 * @returns {number}
 */
export function rulingsWaiting(project) {
  return Array.isArray(project.needs) ? project.needs.length : 0;
}

/**
 * Sent back over the last four hours: every reject or reopen (SENT_BACK_KINDS), and its share of the verdicts
 * (accepts plus sent back), from the state's own four-hour reads.
 *
 * @param {{ dashboardRecent?: { sentBack?: number, accepted?: number } | null }} project
 * @returns {{ count: number, verdicts: number, share: number, hours: 4 }}
 */
export function sentBackRecent(project) {
  const recent = project.dashboardRecent ?? {};
  const count = Number.isInteger(recent.sentBack) ? recent.sentBack : 0, accepted = Number.isInteger(recent.accepted) ? recent.accepted : 0;
  const verdicts = count + accepted;
  return { count, verdicts, share: verdicts ? count / verdicts : 0, hours: 4 };
}

/**
 * The first recording of each item's current merge: the landing every page counts, once, at that time (#7763).
 * Why: the Dashboard, Pace and the tour each matched merge events their own way, so one board showed 1 and 3 landed at once.
 *
 * @param {Map<number, string> | Record<number, string>} commits - Each landed item's merged commit, by item id.
 * @param {{ item_id: number, event_at: string, event_detail?: string }[]} events - The board's merged events, oldest first.
 * @returns {{ id: number, commit: string, at: number }[]}
 */
export function firstLandings(commits, events) {
  const known = commits instanceof Map ? commits : new Map(Object.entries(commits).map(([id, commit]) => [Number(id), commit]));
  const first = new Map();
  for (const event of events) {
    const commit = known.get(event.item_id), at = Date.parse(event.event_at);
    if (commit === undefined || first.has(event.item_id) || !Number.isFinite(at)) continue;
    let seen = null;
    try { seen = JSON.parse(event.event_detail || '{}').commit; } catch { /* A malformed receipt lists nothing. */ }
    if (seen === commit) first.set(event.item_id, { id: event.item_id, commit, at });
  }
  return [...first.values()];
}

/**
 * Whether an item has landed: it carries a merge commit, whatever its status [C7].
 * Why: a hand landing closes the item as withdrawn but records the merge, so the card, counts and In flight read this one fact, never the status alone.
 *
 * @param {{ merged?: unknown, stage?: string } | null | undefined} item
 * @returns {boolean}
 */
export function itemLanded(item) {
  return Boolean(item && (item.merged || item.stage === 'merged'));
}

/**
 * The landed counts of one state: every landed item, and the last four and twenty-four hours of landings.
 *
 * @param {{ items?: any[], dashboardLanded?: { id: number, at?: number }[] }} project - Items and the last day's landings (each with its time).
 * @param {number} now
 * @returns {{ total: number, last4h: number, last24h: number }}
 */
export function landedCounts(project, now) {
  const recent = (project.dashboardLanded ?? []).filter(entry => Number.isFinite(entry.at) && entry.at <= now);
  const total = (project.items ?? []).filter(itemLanded).length;
  const within = hours => recent.filter(entry => entry.at > now - hours * 3_600_000).length;
  return { total: Math.max(total, recent.length), last4h: within(4), last24h: within(24) };
}

/**
 * The open items the Dashboard's NOW calls ready (nothing blocks them, no hold names them or their lane), and the ones
 * it calls blocked: the one definition Release and Roadmap read too, so no item is ready on one page and blocked on another.
 *
 * @param {{ items?: any[], itemHolds?: { item: number }[], holds?: { hold_lane: string }[] }} project
 * @returns {{ ready: number[], blocked: number[] }}
 */
export function readyAndBlocked(project) {
  const heldItems = new Set((project.itemHolds ?? []).map(hold => hold.item)), heldLanes = new Set((project.holds ?? []).map(hold => hold.hold_lane));
  const ready = [], blocked = [];
  for (const item of project.items ?? []) {
    if (item.status !== 'open' || heldItems.has(item.id) || heldLanes.has(item.lane)) continue;
    (item.blockedBy?.length ? blocked : ready).push(item.id);
  }
  return { ready, blocked };
}

/**
 * Each release's summary with its waiting items split: the ones NOW calls ready get their own `ready` count and leave
 * `waiting`, which then counts only what still waits on something.
 *
 * @param {any[]} milestones
 * @param {number[]} ready - The ready item ids (readyAndBlocked).
 * @returns {any[]}
 */
export function splitReady(milestones, ready) {
  const ids = new Set(ready);
  return (milestones ?? []).map(milestone => {
    const summary = milestone?.summary;
    if (!summary || !Number.isInteger(summary.waiting)) return milestone;
    const count = Math.min(summary.waiting, (milestone.items ?? []).filter(entry => ids.has(entry.id) && entry.state !== 'landed').length);
    return { ...milestone, summary: { ...summary, ready: count, waiting: summary.waiting - count } };
  });
}

/**
 * A board state with its releases split by the ready definition NOW uses; a state without releases comes back as it was.
 * It never changes the state it reads, so the page can apply it to every read of a state it keeps.
 *
 * @param {{ milestones?: any[] }} state
 * @returns {object}
 */
export function withReadySplit(state) {
  return state?.milestones ? { ...state, milestones: splitReady(state.milestones, readyAndBlocked(state).ready) } : state;
}

/**
 * The shared counts of one board state, read once per state so every page shows the same numbers.
 *
 * @param {object} project - The board state, with needs, dashboardRunners, dashboardRecent and dashboardLanded.
 * @param {number} now - The state's clock in milliseconds.
 * @returns {{ agents: number, agentIds: string[], joined: number, runners: number, rulings: number, sentBack: { count: number, verdicts: number, share: number, hours: 4 },
 *   landed: { total: number, last4h: number, last24h: number }, ready: number, blocked: number }}
 */
export function boardCounts(project, now) {
  const agentIds = agentsAtWork(project, now), split = readyAndBlocked(project);
  return { agents: agentIds.length, agentIds, joined: (project.agents ?? []).filter(agent => agent.agent_id !== 'coordinator').length, runners: runnersReporting(project), rulings: rulingsWaiting(project), sentBack: sentBackRecent(project),
    landed: landedCounts(project, now), ready: split.ready.length, blocked: split.blocked.length };
}
