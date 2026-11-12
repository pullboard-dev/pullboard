/** Read milestone references across the boards registered on this machine. */
import {
  basename,
  resolve,
  join,
} from 'node:path';
import {
  codeIsFromMain,
  repoInfo,
  withProjectGitTimeout,
} from "../../../git/index.js";
import { workProgress } from './progress.js';
import { itemProgress } from './progress.js';
import { milestoneReferencesToRemove } from "./milestones.js";

/** Require explicit board readers before resolving local or foreign roadmap state. */
function roadmapPorts(ports, names) {
  if (!names.every(name => name === 'PERSON' ? typeof ports?.PERSON === 'string' : typeof ports?.[name] === 'function')) throw new TypeError('roadmap needs explicit store ports');
  return ports;
}

/** Parse a registered-project reference and resolve only an unambiguous project name or basename. */
export function resolveMilestoneProjectReference(reference, projects) {
  const match = /^(.+)#([1-9]\d*)$/.exec(reference);
  if (!match) return null;
  const [, repo, number] = match;
  const candidates = projects.filter((project) => project.name === repo || basename(project.root) === repo);
  return { repo, number, project: candidates.length === 1 ? candidates[0] : null };
}

/** Collect unambiguous registered aliases for one local item before milestone cleanup. */
export function localMilestoneAliases(root, board, id, ports) {
  const { milestones, listApiProjects } = roadmapPorts(ports, ["milestones", "listApiProjects"]);
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
export async function withdrawWithMilestones(ctx, board, me, id, reason, ordered, ports) {
  roadmapPorts(ports, ["milestones", "listApiProjects"]);
  await ordered(ctx, board, 'withdraw', [id, { agentId: me.id, reason }]);
  const removals = milestoneReferencesToRemove(board, [id, ...localMilestoneAliases(ctx.info.root, board, id, ports)], ports);
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
  const ports = roadmapPorts(options.ports, ["closeBoard", "getItem", "laneHolds", "listItems", "openBoard", "roadmap", "eventsOfKinds", "openDecisions", "PERSON", "workQueue"]);
  const { closeBoard, getItem, laneHolds, listItems, openBoard, roadmap } = ports;
  const projects = (options.projects ?? roadmapPorts(options.ports, ["listApiProjects"]).listApiProjects)();
  let hiddenExternal = 0;
  const externalItems = new Map();
  const hidden = () => ({ id: `external-${++hiddenExternal}`, title: 'External item', status: 'unavailable' });
  const resolveExternal = (reference) => {
    const parsed = resolveMilestoneProjectReference(reference, projects);
    if (!parsed) return options.hideOutOfScope ? hidden() : { id: reference, title: reference, status: 'unavailable' };
    const { repo, number, project } = parsed;
    if (!project) return options.hideOutOfScope ? hidden() : { id: reference, title: `#${number} (${repo})`, status: 'unavailable' };
    try {
      return withProjectGitTimeout(project.root, () => {
        const info = repoInfo(project.root);
        const other = resolve(project.root) === resolve(root)
          ? board
          : openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
        try {
          const item = getItem(other, Number(number));
          externalItems.set(reference, { item, progress: itemProgress(other, item.item_id), held: Boolean(item.item_hold_reason)
            || laneHolds(other).some(hold => hold.hold_lane === item.item_lane) });
          return { id: reference, title: item.item_title, status: item.item_status, landed: Boolean(item.item_merged_commit) };
        } finally {
          if (other !== board) closeBoard(other);
        }
      });
    } catch {
      return options.hideOutOfScope ? hidden() : { id: reference, title: `#${number} (${repo})`, status: 'unavailable' };
    }
  };
  const milestones = roadmap(board, resolveExternal);
  const progressById = workProgress(board);
  const items = new Map(listItems(board, { all: true }).map(item => [item.item_id, item]));
  const holds = new Set(laneHolds(board).map(hold => hold.hold_lane));
  const now = board.clock.now().getTime();
  const pace = landingPace(board, items, now, ports);
  const needsYou = personDecisionItems(board, ports);
  const placed = queuePositions(board, ports);
  const landedAt = firstLandings(board, items, ports);
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
    const ordered = queueOrdered(milestone, placed, landedAt).map(entry => ({ ...entry,
      progress: typeof entry.id === 'number' ? progressById.get(entry.id) : externalItems.get(entry.id)?.progress ?? null }));
    const progress = ordered.map(entry => entry.progress).filter(Boolean);
    return { ...milestone, items: ordered, summary, progress: { landed: milestone.landed, total: milestone.total,
      holders: [...new Set(progress.map(entry => entry.holder).filter(Boolean))],
      waits: [...new Set(ordered.flatMap(entry => entry.progress?.waits ?? [`${entry.id}: progress unavailable`]))],
      idleMinutes: progress.length ? Math.min(...progress.map(entry => entry.idleMinutes)) : null,
      idleBasis: 'board activity; worktree activity unknown' } };
  });
}

/** Each open item's 1-based position in pullboard queue, from the queue's own ordering (workQueue), never a second sort. */
function queuePositions(board, ports) {
  const positions = new Map();
  if (typeof ports.buildOrder !== 'function') return positions;
  const queue = ports.workQueue(board, ports);
  for (const item of [...queue.releases.flatMap(release => release.items), ...queue.unreleased]) positions.set(item.id, positions.size + 1);
  return positions;
}

/** When each landed local item first recorded its current merge, for landing order. */
function firstLandings(board, items, ports) {
  const times = new Map();
  for (const event of ports.eventsOfKinds(board, ['merged'])) {
    const item = items.get(event.item_id);
    if (!item?.item_merged_commit || times.has(event.item_id)) continue;
    if (JSON.parse(event.event_detail).commit === item.item_merged_commit) times.set(event.item_id, Date.parse(event.event_at));
  }
  return times;
}

/** A milestone's items as agents pull them: queued items in queue order with their position, other items as added, landed items last in landing order. */
function queueOrdered(milestone, placed, landedAt) {
  const queued = milestone.items.filter(entry => placed.has(entry.id)).sort((a, b) => placed.get(a.id) - placed.get(b.id)).map(entry => ({ ...entry, position: placed.get(entry.id) }));
  const verified = milestone.items.map((entry, index) => ({ entry, index })).filter(({ entry }) => !placed.has(entry.id) && (entry.state === 'landed' || entry.state === 'accepted'));
  const rest = milestone.items.filter(entry => !placed.has(entry.id) && entry.state !== 'landed' && entry.state !== 'accepted');
  const key = ({ entry }) => entry.state === 'landed' ? landedAt.get(entry.id) ?? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER;
  verified.sort((a, b) => key(a) - key(b) || a.index - b.index);
  return [...queued, ...rest, ...verified.map(({ entry }) => entry)];
}

/** Exact first matching merge observations shared by roadmap display and its cache-window boundary. */
export function qualifyingLandingTimes(history, items) {
  const first = new Map();
  for (const event of history) {
    if (event.event_kind !== 'merged') continue;
    const item = items.get(event.item_id);
    if (!['verified', 'withdrawn'].includes(item?.item_status) || !item.item_merged_commit || first.has(event.item_id)) continue;
    if (JSON.parse(event.event_detail).commit !== item.item_merged_commit) continue;
    first.set(event.item_id, Date.parse(event.event_at));
  }
  return [...first.values()].filter(Number.isFinite);
}

/** Count distinct currently landed local items at their first recording of the current merge. */
export function landingPace(board, items, now, ports) {
  const { eventsOfKinds } = roadmapPorts(ports, ["eventsOfKinds"]);
  const times = qualifyingLandingTimes(eventsOfKinds(board, ['merged']), items).filter(at => at <= now);
  return { last6h: times.filter(at => at > now - 6 * 3_600_000).length,
    last2h: times.filter(at => at > now - 2 * 3_600_000).length,
    last24h: times.filter(at => at > now - 24 * 3_600_000).length };
}

/** Associate open person questions with typed item evidence and explicit local item references. */
function personDecisionItems(board, ports) {
  const { openDecisions, PERSON } = ports;
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
