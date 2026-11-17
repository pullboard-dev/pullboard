import { gitExecFileSync } from '../../../../packages/git/index.js';
import { trunkBranch } from './item/folder.js';

/** Run Git in `root` for one value, or null when Git refuses (no trunk branch, unborn HEAD). */
function read(root, args) {
  try { return gitExecFileSync(args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

/** A base age in the largest whole unit, such as 5 min, 3 h or 2 days. */
function ageText(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 2_880) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1_440)} days`;
}

/**
 * The one line a seat sees when its worktree HEAD is behind main: commits behind and the age of its base.
 * Why: on 2 Nov all 40 agent worktrees sat 190-509 commits behind main and nothing told the seat (#2462).
 *
 * @param {string} root - The seat's checkout.
 * @param {number} nowMs - The current time in ms.
 * @returns {string|null} The line, or null when the checkout is level with main or cannot be compared.
 */
export function lagLine(root, nowMs) {
  const trunk = trunkBranch(root);
  const behind = Number(read(root, ['rev-list', '--count', `HEAD..${trunk}`]));
  if (!Number.isInteger(behind) || behind <= 0) return null;
  const base = read(root, ['merge-base', 'HEAD', trunk]);
  const baseSeconds = base ? Number(read(root, ['show', '-s', '--format=%ct', base])) : NaN;
  const age = Number.isFinite(baseSeconds) ? `, its base is ${ageText(nowMs - baseSeconds * 1000)} old` : '';
  return `this checkout is ${behind} commit${behind === 1 ? '' : 's'} behind ${trunk}${age}; merge ${trunk} before you build`;
}

/**
 * Print the lag line for this seat's checkout, when it has one.
 *
 * @param {{ say: (line: string) => void }} io
 * @param {{ info: { root: string }, clock: { now: () => Date } }} ctx
 */
export function sayLag(io, ctx) {
  const line = lagLine(ctx.info.root, ctx.clock.now().getTime());
  if (line) io.say(line);
}
