/**
 * A verdict and a moving trunk (#928). The merge train lands every few minutes and a review takes about ten, so a
 * verdict refused whenever main moved at all is lost to landings that touch nothing it judged. With
 * `verify.unrelatedTrunkMoves` on, a move is kept when its commits change none of the item's files and none of the
 * files its check and affected tests read; anything else, or anything the selection cannot see, refuses as before.
 */
import { execFileSync } from './windows-child-process.js';
import { selectAffectedTests } from './affected-tests.js';
import { explicitCheckFiles } from './browser-admission.js';

/** Run git in the reviewer's checkout and return its trimmed output. */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The paths a range of commits changed, without rename pairing so both sides of a move count. */
function changedBetween(root, from, to) {
  return git(root, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(Boolean);
}

/**
 * Judge a trunk that moved from `from` to `to` while an item was reviewed. Returns the moved commits and, when the move
 * reaches the review, the first file that overlaps and why; `overlap` is null when every moved commit is unrelated.
 *
 * @param {string} root
 * @param {{ from: string, to: string, item: { item_claim_head?: string|null }, checkedCommit: string, check: string|null }} review
 * @returns {Promise<{ moved: string[], overlap: string|null }>}
 */
export async function judgeTrunkMove(root, { from, to, item, checkedCommit, check }) {
  const moved = git(root, ['rev-list', '--reverse', `${from}..${to}`]).split('\n').filter(Boolean);
  const movedFiles = changedBetween(root, from, to);
  const base = git(root, ['merge-base', from, checkedCommit]);
  const itemFiles = new Set(changedBetween(root, base, checkedCommit));
  const touched = movedFiles.find((path) => itemFiles.has(path));
  if (touched) return { moved, overlap: `${touched}, a file this item changed` };
  const checkFiles = check ? await explicitCheckFiles(root, check, { commit: checkedCommit }) : null;
  if (check && !checkFiles) return { moved, overlap: `${movedFiles[0] ?? to}, since the check is not an explicit test selection, so what it reads cannot be bounded` };
  const affected = selectAffectedTests(root, { base: item.item_claim_head ?? base, trunk: from, commit: checkedCommit });
  if (affected.full) return { moved, overlap: `${movedFiles[0] ?? to}, since this item's affected tests are the full suite (${affected.reason})` };
  const read = new Set([...(checkFiles ?? []), ...affected.files]);
  for (const path of movedFiles) {
    const reach = selectAffectedTests(root, { base: from, commit: to, changed: [path] });
    if (reach.full) return { moved, overlap: `${path}, whose effect on tests cannot be bounded (${reach.reason})` };
    const test = reach.files.find((file) => read.has(file));
    if (test) return { moved, overlap: `${path}, which ${test} reads` };
  }
  return { moved, overlap: null };
}
