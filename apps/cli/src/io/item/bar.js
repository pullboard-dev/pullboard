/** Bars a builder cannot satisfy: a check or criterion naming paths missing from main [C7]. */
import { tryGit } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { trunkBranch } from './folder.js';
import { laneOf } from '../../../../../packages/seats/index.js';

/** laneOf names the coordinator for every path no lane owns. */
const COORDINATOR = 'coordinator';

/**
 * The paths a bar names that the build cannot reach on main: absent from main and owned by no lane, such as the test/ and
 * bin/ layout the Cells move retired, which no seat may recreate. Why: 284 live items named such paths and every core
 * seat stopped on one; a path absent from main inside a lane's folders is how a bar asks for a new file, so it stays allowed.
 *
 * @param {{ criterion?: string, check?: string }} bar - Its check and criterion; a brief's file list is guidance, not the bar.
 * @param {(paths: string[]) => Set<string>} present - Which of these paths exist on main.
 * @param {(path: string) => boolean} owned - Whether a lane owns the path.
 * @param {Function} barPaths - The add command's path reader, passed in so the claim path never loads the add command.
 * @returns {string[]}
 */
export function missingBarPaths(bar, present, owned, barPaths) {
  const named = barPaths({ criterion: bar.criterion, check: bar.check }).filter(path => path !== 'pullboard.json');
  if (!named.length) return [];
  const found = present(named);
  return named.filter(path => !found.has(path.replace(/\/$/u, '')) && !owned(path));
}

/**
 * Which of `paths` (files or folders) exist on the trunk, from one Git listing of its tree;
 * every path when the trunk cannot be read, so an unreadable repository never refuses a bar.
 *
 * @param {string} root
 * @returns {(paths: string[]) => Set<string>}
 */
export function onTrunk(root) {
  return paths => {
    const clean = paths.map(path => path.replace(/\/$/u, ''));
    const listed = tryGit(root, ['ls-tree', '-r', '--name-only', trunkBranch(root)]);
    if (listed.status !== 0) return new Set(clean);
    const folders = new Set(), files = new Set(listed.stdout.split('\n').filter(Boolean));
    for (const file of files) for (let at = file.indexOf('/'); at > 0; at = file.indexOf('/', at + 1)) folders.add(file.slice(0, at));
    return new Set(clean.filter(path => files.has(path) || folders.has(path)));
  };
}

/** The BAR_PATH_MISSING refusal for a bar naming paths missing from main, or null. */
export async function missingPathRefusal(ctx, bar) {
  // Loaded on use: the add command imports the claim helper, which calls this.
  const { barPaths } = await import('../commands/add.js');
  const missing = missingBarPaths(bar, onTrunk(ctx.info.root), path => laneOf(ctx.config, path) !== COORDINATOR, barPaths);
  return missing.length ? new Refused('BAR_PATH_MISSING', `the bar names ${missing.join(', ')}, missing from main, so no build can satisfy it`,
    'name the paths where they live on main now (pullboard edit <id> --criterion/--check/--brief), or withdraw the item') : null;
}

/** Refuse an added or edited bar that names a path missing from main [C7]. */
export async function requireBarPathsOnMain(ctx, bar) {
  const refusal = await missingPathRefusal(ctx, bar);
  if (refusal) throw refusal;
}

/**
 * Refuse a claim of an open or claimed item whose bar names a path missing from main, on every claim route (claim,
 * next, run), so a builder is never handed a bar no build can satisfy (#5709).
 *
 * @param {any} ctx
 * @param {any} board
 * @param {number} id
 */
export async function refuseClaimMissingPaths(ctx, board, id) {
  const item = board.nativePorts.getItem(board, id);
  if (['open', 'claimed'].includes(item.item_status)) await requireBarPathsOnMain(ctx, { criterion: item.item_criterion, check: item.item_check });
}
