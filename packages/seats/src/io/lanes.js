/**
 * Lanes (L1, L2): which folders each lane owns. The board, `pullboard lanes` and the pre-commit
 * lane check all read the same declaration in pullboard.json, and `pullboard lane add` writes it.
 */
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_FILE,
  COORDINATOR,
  configFromSource,
  loadConfig,
} from '../../../config/index.js';
import { Refused } from '../../../kernel/index.js';
import { laneOf } from '../logic/lane/lookup.js';

export { laneOf };

/** The one spelling of "the whole repo" a lane may own. */
const ROOT_LANE_PATH = './';

/**
 * Every lane name, the coordinator first.
 *
 * @param {any} config
 * @returns {string[]}
 */
export function laneNames(config) {
  return [COORDINATOR, ...Object.keys(config.lanes)];
}

/**
 * True for a lane the config declares, or the coordinator.
 *
 * @param {any} config
 * @param {string} name
 * @returns {boolean}
 */
export function isLane(config, name) {
  return name === COORDINATOR || Object.hasOwn(config.lanes, name);
}

/**
 * The paths a lane may not change, each as `path (owner's)`. Shared paths are open to every lane,
 * and the coordinator may change anything.
 *
 * @param {any} config
 * @param {string} lane
 * @param {string[]} paths
 * @returns {string[]}
 */
export function outOfLane(config, lane, paths) {
  if (lane === COORDINATOR) return [];
  const isShared = (path) => config.shared.some((prefix) => path.startsWith(prefix));
  return paths
    .filter((path) => !isShared(path) && laneOf(config, path) !== lane)
    .map((path) => `${path} (${laneOf(config, path)}'s)`);
}

/**
 * One path as a lane prefix: forward slashes, no leading `./`, and a trailing slash on a folder
 * that exists, so `packages/web` cannot also claim `packages/webby`. `.` and `./` both mean the
 * repo root and both become `./` (P7754), which `laneOf` treats as owning every path.
 *
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
export function lanePath(root, path) {
  const given = String(path).trim().replaceAll('\\', '/');
  if (/^(?:\.(?:\/+|$))+$/u.test(given)) return ROOT_LANE_PATH;
  let prefix = given.replace(/^(?:\.\/)+/u, '');
  if (!prefix || prefix.startsWith('/') || prefix.split('/').includes('..')) {
    throw new Refused('BAD_LANE_PATH', `"${path}" is not a folder inside this repo; give a path relative to the repo root, like packages/web/`);
  }
  if (!prefix.endsWith('/') && existsSync(join(root, prefix)) && statSync(join(root, prefix)).isDirectory()) prefix += '/';
  return prefix;
}

/**
 * `pullboard lane add` (L1, I1): declare a new lane in pullboard.json. It refuses a name that is
 * already a lane and a path some lane already owns, naming the owner, because two lanes owning
 * one folder would leave the pre-commit check deciding by accident. Every other setting in the
 * file stays as it was.
 *
 * @param {string} root
 * @param {string} name
 * @param {string[]} paths
 * @returns {{ lane: string, owns: string[] }}
 */
export function addLane(root, name, paths) {
  const config = loadConfig(root);
  if (name === COORDINATOR || name === 'all') {
    throw new Refused('LANE_TAKEN', `"${name}" belongs to the coordinator; pick another lane name, like web or api`);
  }
  if (Object.hasOwn(config.lanes, name)) {
    const owns = config.lanes[name].owns.join(' ') || 'no folders';
    throw new Refused('LANE_TAKEN', `lane "${name}" already exists and owns ${owns}; pick another name, or see: pullboard lanes`);
  }
  const owns = [...new Set(paths.map((path) => lanePath(root, path)))];
  if (!owns.length) throw new Refused('USAGE', 'give the folders the lane owns: pullboard lane add <name> --owns <path>[,<path>]');
  for (const path of owns) {
    const owner = laneOf(config, path);
    if (owner !== COORDINATOR) {
      throw new Refused('PATH_OWNED', `${path} is already owned by lane "${owner}"; pick a folder no lane owns (see: pullboard lanes); carving a sub-folder out of ${owner} is a hand edit of "lanes" in ${CONFIG_FILE}`);
    }
  }
  const file = join(root, CONFIG_FILE);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.lanes = { ...(raw.lanes ?? {}), [name]: { owns } };
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  try { configFromSource(text); }
  catch (error) {
    if (!(error instanceof Refused)) throw error;
    throw new Refused('BAD_LANE', `lane "${name}" cannot be added: names are lowercase words of letters, digits and dashes, like web or api-2; pick another name`);
  }
  writeFileSync(file, text);
  return { lane: name, owns };
}
