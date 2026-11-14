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
 * The four shared counts of one board state, read once per state so every page shows the same numbers.
 *
 * @param {object} project - The board state, with needs, dashboardRunners and dashboardRecent.
 * @param {number} now - The state's clock in milliseconds.
 * @returns {{ agents: number, agentIds: string[], runners: number, rulings: number, sentBack: { count: number, verdicts: number, share: number, hours: 4 } }}
 */
export function boardCounts(project, now) {
  const agentIds = agentsAtWork(project, now);
  return { agents: agentIds.length, agentIds, runners: runnersReporting(project), rulings: rulingsWaiting(project), sentBack: sentBackRecent(project) };
}
