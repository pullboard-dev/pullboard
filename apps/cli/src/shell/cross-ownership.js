/** A bar that names a coordinator-owned path cannot be built by a lane seat, so it is refused up front [C7,#2650]. */
import { briefFiles } from '../../../../packages/items/index.js';
import { laneOf } from '../../../../packages/seats/index.js';
import { Refused } from '../../../../packages/kernel/index.js';

/** The coordinator's lane and seat id: laneOf gives it every path no lane owns (the queue cell's COORDINATOR). */
const COORDINATOR = 'coordinator';

/** A path-like token: a directory with a trailing slash, a dotted folder, or a file with an extension, or pullboard.json. */
const PATH_TOKEN = /(?:^|[\s`'"(\[,])((?:\.?[\w-]+\/)+(?:[\w.-]*\.[\w-]+|[\w.-]*(?=[\s`'")\],;:]|$))|pullboard\.json)/gu;

/**
 * The path-like tokens in free text, with a leading ./ removed.
 * Why: criterion, check and brief are prose, so only tokens shaped like paths can be judged by lane ownership.
 */
export function pathTokens(text) {
  const tokens = new Set();
  for (const match of String(text ?? '').matchAll(PATH_TOKEN)) {
    const token = match[1].replace(/^\.\//u, '');
    if (token.endsWith('/') || token.includes('.') || token === 'pullboard.json') tokens.add(token);
  }
  return [...tokens];
}

/**
 * The paths an item's criterion, check or brief Files section names that no lane owns, so only the coordinator may change them.
 * Why: add and claim both read all three, so a lane item already on the board whose criterion alone names a
 * coordinator-owned path is refused at claim as it would be at add; `prose: false` reads only the check and Files list.
 *
 * @param {object} config - The frozen policy with its lanes.
 * @param {{ criterion?: string, check?: string, brief?: string }} item - The item's bar.
 * @param {{ prose?: boolean }} [options]
 * @returns {string[]}
 */
export function coordinatorPaths(config, item, { prose = true } = {}) {
  const named = [...(prose ? pathTokens(item.criterion) : []), ...pathTokens(item.check), ...briefFiles(item.brief ?? '').flatMap(file => pathTokens(` ${file}`))];
  return [...new Set(named)].filter(path => laneOf(config, path) === COORDINATOR);
}

/** The next step of a cross-ownership refusal: the lane piece, then the coordinator piece filed --after it. */
export function splitAdvice(lane, title, paths) {
  return `split it: file the lane piece with only ${lane} paths (pullboard add ${lane} "${title}"), then file the coordinator piece `
    + `(pullboard add coordinator "${title}: coordinator piece" --after <lane item id>) naming ${paths.join(', ')}`;
}

/** Refuse a lane item whose bar names a coordinator-owned path; the coordinator and the person may name any path. */
export function requireNoCoordinatorPath(config, me, item, options) {
  if (me.id === COORDINATOR || item.lane === COORDINATOR || item.by === 'person') return;
  const paths = coordinatorPaths(config, item, options);
  if (!paths.length) return;
  throw new Refused('CROSS_OWNERSHIP', `the bar names ${paths.join(', ')}, which no lane owns, so lane ${item.lane} cannot build it`,
    splitAdvice(item.lane, item.title, paths));
}
