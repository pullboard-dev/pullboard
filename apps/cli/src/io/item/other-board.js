/** The other-board ask of pullboard add: an item whose files lie in another board's registered root asks where it belongs before it is filed [C7]. */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { listProjects } from '../../../../../packages/seats/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { pathTokens } from './bar.js';

/** An absolute or home-relative path in free text, which the relative-path tokenizer does not read. */
const ABSOLUTE_PATH = /(?:^|[\s`'"(\[,])(~?\/[^\s`'")\],;:]+)/gu;

/** The paths a bar names, each made absolute against the filing board's root. */
function namedPaths(root, item) {
  const text = [item.criterion, item.check, item.brief].filter(Boolean).join('\n');
  const absolute = [...text.matchAll(ABSOLUTE_PATH)].map(match => resolve(match[1].startsWith('~') ? homedir() + match[1].slice(1) : match[1]));
  return [...new Set([...absolute, ...pathTokens(text).map(token => resolve(root, token))])];
}

/** Whether a path is the root or lies under it. */
function under(root, path) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Ask where an item belongs when its bar names files under another registered board's root.
 * Why: the same work then lives on two boards; filing it where its files are, or saying why it stays (--here "<reason>"), are each a real answer, so this is an ask, not a wall. A registry that cannot
 * be read never blocks filing.
 *
 * @param {object} ctx - The command context.
 * @param {object} item - The item about to be filed.
 * @param {string | undefined} here - The `--here` value: why the item is filed on this board.
 * @returns {{ boards: string[], reason: string } | null} The recorded answer, or null when nothing was asked.
 */
export function guardOtherBoard(ctx, item, here) {
  if (here !== undefined && !String(here).trim()) throw new Refused('OTHER_BOARD_REASON', '--here needs the reason this item is filed on this board', 'use --here "why this board owns the files"');
  const root = resolve(ctx.info.root);
  let projects;
  try { projects = listProjects({ pruneMissing: false }).map(project => ({ ...project, root: resolve(project.root) })); } catch { return null; }
  const owners = projects.filter(project => project.root !== root);
  if (!owners.length) return null;
  const other = new Map();
  for (const path of namedPaths(root, item)) {
    // The deepest registered root wins, so a board nested inside this one owns its own folder.
    const owner = [...owners, { root }].filter(project => under(project.root, path)).sort((a, b) => b.root.length - a.root.length)[0];
    if (owner && owner.root !== root) other.set(owner.root, owner);
  }
  if (!other.size) return null;
  const unlinked = [...other.values()];
  const names = unlinked.map(project => project.handle ?? project.name);
  if (here !== undefined) return { boards: names, reason: String(here).trim() };
  throw new Refused('OTHER_BOARD_ASK', `this item names files that belong to the ${names.join(', ')} board on this machine (${unlinked.map(project => project.root).join(', ')})`,
    `file it on that board (cd there and run pullboard add), or file it here with --here "why this board owns the files"`);
}
