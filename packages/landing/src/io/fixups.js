/** The fixups product landing carries so the blitz scripts need not: lint listing rebind, renames, ceilings merge, row-aware blame [C7,#5560]. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { git } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

const LINT_DIR = 'packages/codemap/data/baselines/lints';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** A listing file's text: indented while short, one line once it passes 500 lines, as the codemap writes it. */
const encode = value => { const pretty = JSON.stringify(value, null, 2) + '\n'; return pretty.split('\n').length - 1 < 500 ? pretty : JSON.stringify(value) + '\n'; };

/**
 * Merge a ceilings file three ways: a row both sides changed takes the lower number, a row one side deleted stays deleted,
 * and a row either side added is kept. Why: two items that each lowered a ceiling must both hold after they merge [C7,#5560].
 *
 * @param {unknown} base - The common ancestor's value.
 * @param {unknown} ours - One side's value.
 * @param {unknown} theirs - The other side's value.
 * @returns {unknown}
 */
export function mergeCeilings(base, ours, theirs) {
  if (typeof ours === 'number' && typeof theirs === 'number') return Math.min(ours, theirs);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(ours) && !object(theirs)) return theirs ?? ours;
  const [left, right, root] = [ours, theirs, base].map(value => object(value) ? value : {});
  const merged = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (key in left && key in right) merged[key] = mergeCeilings(root[key], left[key], right[key]);
    else if (key in root) continue;
    else merged[key] = key in left ? left[key] : right[key];
  }
  return merged;
}

/**
 * Rebind the cells' lint listing to the shard bytes on disk: each metric's shard digests and count follow the shards, and each
 * cell file's base digest and own digest follow the listing. Why: items that each changed a shard leave the listing stale
 * once merged, and the blitz script that rebound it is not part of the product [C7,#5560].
 *
 * @param {string} root A checkout of the merged tree.
 * @returns {string[]} The repository-relative files it rewrote.
 */
export function rebindCellListing(root) {
  const folder = join(root, LINT_DIR);
  // The listing is the one file here whose metrics name shards; the shards and the cells folder are the others.
  const listed = fs.exists(folder) ? fs.list(folder).filter(file => file.endsWith('.json')).sort().find(file => {
    try { return Object.values(JSON.parse(fs.readFile(join(folder, file), 'utf8')).metrics ?? {}).some(row => Array.isArray(row?.shards)); } catch { return false; }
  }) : null;
  if (!listed) return [];
  const index = join(folder, listed);
  const changed = [];
  const write = (path, text) => { if (!fs.exists(path) || fs.readFile(path, 'utf8') !== text) { fs.writeFile(path, text); changed.push(path.slice(root.length + 1)); } };
  const listing = JSON.parse(fs.readFile(index, 'utf8'));
  for (const row of Object.values(listing.metrics)) {
    let count = 0;
    for (const shard of row.shards) {
      const file = join(root, shard.file);
      if (!fs.exists(file)) continue;
      const bytes = fs.readFile(file, null);
      shard.sha256 = sha256(bytes);
      count += Object.values(JSON.parse(bytes).allowances ?? {}).reduce((sum, value) => sum + value, 0);
    }
    row.count = count;
  }
  const text = JSON.stringify(listing, null, 2) + '\n';
  write(index, text);
  const baseSha256 = sha256(text);
  const cells = join(root, LINT_DIR, 'cells');
  for (const name of fs.exists(cells) ? fs.list(cells).filter(file => file.endsWith('.json')).sort() : []) {
    const cell = JSON.parse(fs.readFile(join(cells, name), 'utf8'));
    for (const row of Object.values(cell.metrics ?? {})) if (Array.isArray(row.remove)) row.remove.sort();
    const payload = { version: cell.version, cell: cell.cell, baseSha256, metrics: cell.metrics };
    write(join(cells, name), encode({ ...payload, sha256: sha256(encode(payload)) }));
  }
  return changed;
}

/** The files a merged tree renamed since its base: `{ from, to }` per rename, found by content so a move and an edit still match. */
export function landingRenames(root, base, head = 'HEAD') {
  const ran = tryGit(root, ['--no-replace-objects', 'diff', '--name-status', '-M', '--diff-filter=R', base, head]);
  if (ran.status !== 0) return [];
  return ran.stdout.split('\n').filter(Boolean).map(row => row.split('\t')).map(([, from, to]) => ({ from, to }));
}

/**
 * The batch entries that added the lines behind the named static rows: each row's line is blamed on the merged tree, and the
 * entry whose own commits hold the blamed commit is charged. Why: charging every item that touched a file reopened accepted
 * work that never wrote the red line [C7,#5560].
 *
 * @param {string} root The landing checkout holding the merged tree.
 * @param {string} base Main's tip the batch was built on.
 * @param {{ id: number, commit: string }[]} entries
 * @param {{ file: string, line: number }[]} rows
 * @returns {Map<number, { file: string, line: number }[]>} Rows by charged entry id; a row nobody added is in none.
 */
export function blameStaticRows(root, base, entries, rows) {
  const owned = new Map(entries.map(entry => [entry.id, new Set(git(root, ['--no-replace-objects', 'rev-list', `${base}..${entry.commit}`]).split('\n').filter(Boolean))]));
  const charged = new Map();
  for (const row of rows) {
    const blame = tryGit(root, ['blame', '--porcelain', '-L', `${row.line},${row.line}`, 'HEAD', '--', row.file]);
    const commit = blame.status === 0 ? /^([0-9a-f]{40,64}) /u.exec(blame.stdout)?.[1] : null;
    const entry = commit ? entries.find(candidate => owned.get(candidate.id).has(commit)) : null;
    if (entry) charged.set(entry.id, [...(charged.get(entry.id) ?? []), row]);
  }
  return charged;
}
