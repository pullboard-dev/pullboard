/**
 * A restructure move rewrites every open bar that names a moved path, in the same landing, with a reason [B4,R2,#5704].
 * Why: a bar freezes the person's words, not the repo's layout; when a move changes a path a criterion or check names,
 * the rewrite is a recorded bar edit a reviewer can see, never a silent drift or a refused claim.
 */
import { Refused } from '../../../../../kernel/index.js';

/** Statuses whose bar is still live: closed items keep the words they landed with. */
const CLOSED = new Set(['withdrawn', 'landed', 'verified']);

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Text with every moved path replaced by its new place. A path is a whole token: `a/b.js` never matches inside
 * `a/b.jsx`, `x/a/b.js` or `a/b.js/c`; a trailing sentence period still matches.
 *
 * @param {string} text
 * @param {{ from: string, to: string }[]} moves
 * @returns {string}
 */
export function rewritePaths(text, moves) {
  let out = text;
  for (const { from, to } of moves) {
    const folder = from.endsWith('/');
    const tail = folder ? '' : '(?![\\w/-]|\\.\\w)';
    out = out.replace(new RegExp(`(?<![\\w./-])${escape(from)}${tail}`, 'gu'), to);
  }
  return out;
}

/**
 * The bar rewrites a move set owes: for each open item naming a moved path, its new criterion and/or check.
 *
 * @param {{ item_id: number, item_status: string, item_criterion?: string | null, item_check?: string | null }[]} items
 * @param {{ from: string, to: string }[]} moves
 * @returns {{ id: number, criterion?: string, check?: string }[]}
 */
export function barRewrites(items, moves) {
  const owed = [];
  for (const item of items) {
    if (CLOSED.has(item.item_status)) continue;
    const criterion = typeof item.item_criterion === 'string' ? rewritePaths(item.item_criterion, moves) : null;
    const check = typeof item.item_check === 'string' ? rewritePaths(item.item_check, moves) : null;
    const change = { id: item.item_id, ...(criterion !== null && criterion !== item.item_criterion ? { criterion } : {}),
      ...(check !== null && check !== item.item_check ? { check } : {}) };
    if (change.criterion !== undefined || change.check !== undefined) owed.push(change);
  }
  return owed;
}

/**
 * Rewrite every open bar naming a moved path through the board's own edit command, each recorded with the reason.
 *
 * @param {{ moves: { from: string, to: string }[], reason: string, run: (args: string[]) => { status: number, stdout: string, stderr: string } }} fields
 *   run: runs one pullboard command in the repository and returns its result.
 * @returns {{ id: number, criterion?: string, check?: string }[]} The rewrites recorded.
 */
export function rewriteMovedBars({ moves, reason, run }) {
  if (typeof reason !== 'string' || !reason.trim()) throw new Refused('BAR_REASON', 'a bar rewrite needs a reason naming the move', 'pass the reason the move records');
  const listed = run(['list', '--json']);
  if (listed.status !== 0) throw new Refused('BAR_LIST', `could not list the open items: ${String(listed.stderr).trim()}`, 'run pullboard list --json and fix what it reports');
  const owed = barRewrites(JSON.parse(listed.stdout).items ?? [], moves);
  for (const change of owed) {
    const edited = run(['edit', String(change.id), ...(change.criterion === undefined ? [] : ['--criterion', change.criterion]),
      ...(change.check === undefined ? [] : ['--check', change.check]), '--reason', reason]);
    if (edited.status !== 0) throw new Refused('BAR_EDIT', `could not rewrite the bar of #${change.id}: ${String(edited.stderr).trim()}`, `file it by hand: pullboard edit ${change.id} --reason "${reason}"`);
  }
  return owed;
}
