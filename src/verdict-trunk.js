/**
 * A verdict and a moving trunk (#928). The merge train lands every few minutes and a review takes about ten, so a
 * verdict refused whenever main moved at all is lost to landings that touch nothing it judged. With
 * `verify.unrelatedTrunkMoves` on, a move is kept when its commits change none of the item's files and none of the
 * files its check and affected tests read; anything else, or anything the selection cannot see, refuses as before.
 */
import { execFileSync } from 'node:child_process';

/** Run git in the reviewer's checkout and return its trimmed output. */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The paths a range of commits changed, without rename pairing so both sides of a move count. */
function changedBetween(root, from, to) {
  return git(root, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(Boolean);
}

/** Count every landed change, including one later reverted; a merge contributes its first-parent change. */
function changedBy(root, commit) {
  return git(root, ['diff-tree', '--root', '--no-commit-id', '--no-renames', '--name-only', '--diff-merges=first-parent', '-r', '-z', commit]).split('\0').filter(Boolean);
}

/**
 * Judge a trunk that moved from `from` to `to` while an item was reviewed or proved. Returns the moved commits and, when
 * the move reaches the work, the first file that overlaps and why; `overlap` is null when every moved commit is
 * unrelated. With `all`, `overlaps` lists every overlapping file instead of stopping at the first.
 *
 * @param {string} root
 * @param {{ from: string, to: string, item: { item_claim_head?: string|null }, checkedCommit: string, check: string|null }} review
 * @param {{ selectAffectedTests: Function, explicitCheckFiles: Function }} services canonical caller-owned graph readers
 * @param {{ all?: boolean }} [options]
 * @returns {Promise<{ moved: string[], overlap: string|null, overlaps: string[] }>}
 */
export async function judgeTrunkMove(root, { from, to, item, checkedCommit, check }, { selectAffectedTests, explicitCheckFiles }, { all = false } = {}) {
  const moved = git(root, ['rev-list', '--reverse', `${from}..${to}`]).split('\n').filter(Boolean);
  const movedFiles = all ? [...new Set(moved.flatMap(commit => changedBy(root, commit)))] : changedBetween(root, from, to);
  const overlaps = [];
  /** Keep one finding; outside `all` mode the first one decides. */
  const found = (text) => { overlaps.push(text); return !all; };
  const result = () => ({ moved, overlap: overlaps[0] ?? null, overlaps });
  const base = git(root, ['merge-base', from, checkedCommit]);
  const itemFiles = new Set(changedBetween(root, base, checkedCommit));
  for (const touched of movedFiles.filter((path) => itemFiles.has(path))) if (found(`${touched}, a file this item changed`)) return result();
  const checkFiles = check ? await explicitCheckFiles(root, check, { commit: checkedCommit }) : null;
  if (check && !checkFiles) { found(`${movedFiles[0] ?? to}, since the check is not an explicit test selection, so what it reads cannot be bounded`); return result(); }
  const affected = selectAffectedTests(root, { base: item.item_claim_head ?? base, trunk: from, commit: checkedCommit });
  if (affected.full) { found(`${movedFiles[0] ?? to}, since this item's affected tests are the full suite (${affected.reason})`); return result(); }
  const read = new Set([...(checkFiles ?? []), ...affected.files]);
  for (const path of movedFiles) {
    if (itemFiles.has(path)) continue;
    const reach = selectAffectedTests(root, { base: from, commit: to, changed: [path] });
    if (reach.full) { if (found(`${path}, whose effect on tests cannot be bounded (${reach.reason})`)) return result(); continue; }
    const test = reach.files.find((file) => read.has(file));
    if (test && found(`${path}, which ${test} reads`)) return result();
  }
  return result();
}
