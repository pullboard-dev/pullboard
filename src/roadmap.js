/** Read milestone references across the boards registered on this machine. */
import {
  basename,
  resolve,
  join,
} from 'node:path';
import {
  closeBoard,
  getItem,
  eventsOfKinds,
  laneHolds,
  listItems,
  milestones,
  openDecisions,
  PERSON,
  openBoard,
  roadmap,
} from './board.js';
import {
  codeIsFromMain,
  repoInfo,
} from './git.js';
import { listApiProjects } from './projects.js';
import { milestoneReferencesToRemove } from './milestones.js';

/** Parse a registered-project reference and resolve only an unambiguous project name or basename. */
export function resolveMilestoneProjectReference(reference, projects) {
  const match = /^(.+)#([1-9]\d*)$/.exec(reference);
  if (!match) return null;
  const [, repo, number] = match;
  const candidates = projects.filter((project) => project.name === repo || basename(project.root) === repo);
  return { repo, number, project: candidates.length === 1 ? candidates[0] : null };
}

/** Collect unambiguous registered aliases for one local item before milestone cleanup. */
export function localMilestoneAliases(root, board, id) {
  const projects = listApiProjects();
  const localRoot = resolve(root);
  const aliases = new Set();
  for (const milestone of milestones(board)) {
    for (const reference of milestone.items) {
      if (typeof reference !== 'string') continue;
      const parsed = resolveMilestoneProjectReference(reference, projects);
      if (!parsed?.project || !Number.isSafeInteger(Number(parsed.number)) || Number(parsed.number) !== id) continue;
      if (resolve(parsed.project.root) === localRoot) aliases.add(reference);
    }
  }
  return [...aliases];
}

/** Withdraw through ordered moves, then remove every local milestone alias and report the result. */
export async function withdrawWithMilestones(ctx, board, me, id, reason, ordered) {
  await ordered(ctx, board, 'withdraw', [id, { agentId: me.id, reason }]);
  const removals = milestoneReferencesToRemove(board, [id, ...localMilestoneAliases(ctx.info.root, board, id)]);
  const left = removals.map(({ name }) => name);
  for (const { name, remove } of removals) {
    await ordered(ctx, board, 'editMilestoneItems', [name, { agentId: me.id, remove }]);
  }
  ctx.io.result?.({ id, reason, milestones: left });
  ctx.io.say(`withdrew #${id}${left.length ? `; removed it from milestone ${left.join(', ')}` : ''}`);
  return 0;
}

/** Resolve a repo-qualified milestone item against registered boards, optionally within an API scope.
 * @param {string} root
 * @param {any} board
 * @param {{ projects?: () => any[], hideOutOfScope?: boolean }} [options]
 * @returns {any[]}
 */
export function milestoneRoadmap(root, board, options = {}) {
  const projects = (options.projects ?? listApiProjects)();
  let hiddenExternal = 0;
  const externalItems = new Map();
  const hidden = () => ({ id: `external-${++hiddenExternal}`, title: 'External item', status: 'unavailable' });
  const resolveExternal = (reference) => {
    const parsed = resolveMilestoneProjectReference(reference, projects);
    if (!parsed) return options.hideOutOfScope ? hidden() : { id: reference, title: reference, status: 'unavailable' };
    const { repo, number, project } = parsed;
    if (!project) return options.hideOutOfScope ? hidden() : { id: reference, title: `#${number} (${repo})`, status: 'unavailable' };
    try {
      const info = repoInfo(project.root);
      const other = resolve(project.root) === resolve(root)
        ? board
        : openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
      try {
        const item = getItem(other, Number(number));
        externalItems.set(reference, { item, held: Boolean(item.item_hold_reason)
          || laneHolds(other).some(hold => hold.hold_lane === item.item_lane) });
        return { id: reference, title: item.item_title, status: item.item_status, landed: Boolean(item.item_merged_commit) };
      } finally {
        if (other !== board) closeBoard(other);
      }
    } catch {
      return options.hideOutOfScope ? hidden() : { id: reference, title: `#${number} (${repo})`, status: 'unavailable' };
    }
  };
  const milestones = roadmap(board, resolveExternal);
  const items = new Map(listItems(board, { all: true }).map(item => [item.item_id, item]));
  const holds = new Set(laneHolds(board).map(hold => hold.hold_lane));
  const now = board.clock.now().getTime();
  const pace = landingPace(board, items, now);
  const needsYou = personDecisionItems(board);
  return milestones.map(milestone => {
    const active = milestone.items.filter(entry => entry.status !== 'withdrawn');
    const summary = { total: active.length, left: active.length - milestone.landed,
      landed: 0, landing: 0, review: 0, building: 0, held: 0, waiting: 0,
      needsYou: active.filter(entry => typeof entry.id === 'number' && needsYou.has(entry.id)).map(entry => entry.id),
      pace: { ...pace }, estimate: null };
    for (const entry of active) {
      const local = typeof entry.id === 'number' ? items.get(entry.id) : null;
      const external = externalItems.get(entry.id);
      const item = local ?? external?.item;
      const held = local ? Boolean(local.item_hold_reason) || holds.has(local.item_lane) : external?.held;
      const state = entry.state === 'landed' ? 'landed'
        : entry.state === 'accepted' ? 'landing'
          : entry.status === 'submitted' ? 'review'
            : item?.item_status === 'claimed' && Date.parse(item.item_lease_until) > now ? 'building'
              : held ? 'held' : 'waiting';
      summary[state]++;
    }
    Object.assign(summary, milestoneForecast(summary.left, pace, Boolean(milestone.shipped)));
    return { ...milestone, summary };
  });
}

/** Exact first matching merge observations shared by roadmap display and its cache-window boundary. */
export function qualifyingLandingTimes(history, items) {
  const first = new Map();
  for (const event of history) {
    if (event.event_kind !== 'merged') continue;
    const item = items.get(event.item_id);
    if (item?.item_status !== 'verified' || !item.item_merged_commit || first.has(event.item_id)) continue;
    if (JSON.parse(event.event_detail).commit !== item.item_merged_commit) continue;
    first.set(event.item_id, Date.parse(event.event_at));
  }
  return [...first.values()].filter(Number.isFinite);
}

/** Count distinct currently landed local items at their first recording of the current merge. */
export function landingPace(board, items, now) {
  const times = qualifyingLandingTimes(eventsOfKinds(board, ['merged']), items).filter(at => at <= now);
  return { last6h: times.filter(at => at > now - 6 * 3_600_000).length,
    last2h: times.filter(at => at > now - 2 * 3_600_000).length,
    last24h: times.filter(at => at > now - 24 * 3_600_000).length };
}

/** Associate open person questions with typed item evidence and explicit local item references. */
function personDecisionItems(board) {
  const ids = new Set();
  for (const question of openDecisions(board, PERSON)) {
    if (question.shout_evidence_item) ids.add(question.shout_evidence_item);
    // A local token is separate from a URL or repo-qualified reference.
    for (const match of question.shout_text.matchAll(/(?:^|[\s([{"'`,;:!?])#([1-9]\d*)\b/gu)) {
      const id = Number(match[1]);
      if (Number.isSafeInteger(id)) ids.add(id);
    }
  }
  return ids;
}


/** Choose the measured window for remaining work; sparse recent history may use a full day [N26]. */
export function milestoneForecast(left, pace, shipped) {
  if (shipped) return { estimate: null, window: null, reason: null };
  if (pace.last6h >= 3) {
    const six = left / (pace.last6h / 6);
    const two = pace.last2h ? left / (pace.last2h / 2) : six;
    return { estimate: { low: Math.round(Math.min(six, two) * 2) / 2,
      high: Math.round(Math.max(six, two) * 2) / 2 }, window: '6h', reason: null };
  }
  if (pace.last24h >= 3) {
    const hours = Math.round(left / (pace.last24h / 24) * 2) / 2;
    return { estimate: { low: hours, high: hours }, window: '24h', reason: null };
  }
  return { estimate: null, window: null, reason: 'few-landings' };
}

/** Format the supplied forecast for the CLI, retaining equal bounds as one number [N26]. */
export function roadmapEstimate(summary) {
  const bounds = summary.estimate;
  if (!bounds) return summary.reason === 'few-landings' ? '; too few landings yet to estimate.' : '; estimate unavailable.';
  const hours = bounds.low === bounds.high ? bounds.low : `${bounds.low} to ${bounds.high}`;
  const pace = summary.window === '24h' ? "the last day's pace" : "today's pace";
  return `; about ${hours} h at ${pace}.`;
}
