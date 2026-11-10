/** Derived audit-time placement, read one reached file at a time; this is never a proof receipt [C7]. */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import { join } from 'node:path';
import { repoInfo } from '../../../../../git/index.js';
import { testsAtStage } from '../economics.js';
import { readTestFileBudgets } from '../file/policy.js';

/** Keep the derived inventory shared across worktrees; gate reads never discover the tree. */
function directory(root) { return join(repoInfo(root).commonDir, 'pullboard', 'test-value-index'); }

/** Validate portable relative paths before they participate in selection. */
function portable(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096
    && !/[\r\n\0\\]/u.test(path) && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path)
    && !path.split('/').some(part => !part || part === '.' || part === '..');
}

/** Hash project paths instead of constructing filesystem paths from report data. */
function entryName(file) { return createHash('sha256').update(file).digest('hex') + '.json'; }

/** Validate one inventory row without traversing unrelated tests. */
function validateRow(row, file = row?.file) {
  if (!portable(file) || row?.file !== file || !['submit', 'landing', 'audit'].includes(row.tier)
    || !Array.isArray(row.testInputs ?? []) || !(row.testInputs ?? []).every(portable)) throw new TypeError('invalid test value placement');
  return row;
}

/** Inventory validation belongs to audit work, never to each change. */
export function validatePlacementIndex(value) {
  if (value?.version !== 1 || !Array.isArray(value.files)) throw new TypeError('missing test value inventory');
  const seen = new Set();
  for (const row of value.files) {
    validateRow(row);
    if (seen.has(row.file)) throw new TypeError('duplicate test value placement');
    seen.add(row.file);
  }
  return value;
}

/** Read only the constant-size published generation pointer. */
function generation(root) {
  const pointer = JSON.parse(readFileSync(join(directory(root), 'current.json'), 'utf8'));
  if (pointer?.version !== 1 || !/^[a-f0-9-]{36}$/u.test(pointer.generation ?? '')) throw new TypeError('invalid test value index generation');
  return pointer.generation;
}

/** Read reached rows from one immutable generation, never the repository-wide report. */
export function readPlacementIndex(root, files) {
  if (!Array.isArray(files) || !files.every(portable)) throw new TypeError('name the reached test files');
  let current;
  try { current = generation(root); } catch { return { version: 1, files: [] }; }
  const rows = [];
  for (const file of new Set(files)) {
    try { rows.push(validateRow(JSON.parse(readFileSync(join(directory(root), current, entryName(file)), 'utf8')), file)); }
    catch { /* Missing or corrupt derived rows remain audit-only, never promoted. */ }
  }
  return { version: 1, generation: current, files: rows };
}

/** Read the complete published report only for an explicit report or audit, never a change gate. */
export function readPlacementReport(root) {
  try { return validatePlacementIndex(JSON.parse(readFileSync(join(directory(root), generation(root), 'report.json'), 'utf8'))); }
  catch { return null; }
}

/** Publish an audit inventory only after every row is written; failure retains the prior pointer. */
export function writePlacementIndex(root, report) {
  validatePlacementIndex(report);
  const store = directory(root);
  const next = randomUUID();
  const folder = join(store, next);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temporary = join(store, `${next}.tmp`);
  try {
    for (const row of report.files) writeFileSync(join(folder, entryName(row.file)), JSON.stringify(row) + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(join(folder, 'report.json'), JSON.stringify(report) + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(temporary, JSON.stringify({ version: 1, generation: next, at: report.at, head: report.head }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(store, 'current.json'));
  } catch (error) {
    rmSync(temporary, { force: true });
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  // Concurrent readers may still use older generations. Cleanup belongs to separate audit
  // maintenance, never to a per-change sweep or a synchronous gate read.
  return next;
}

/** Invalidate changed test-side inputs; work is bounded by reached rows and their own inputs. */
export function indexedStageSelection(root, files, stage, changed = []) {
  const report = readPlacementIndex(root, files);
  const committed = readTestFileBudgets(root, files);
  const touched = new Set(changed);
  const effective = { ...report, files: report.files.map(row => ({ ...row,
    tier: committed.get(row.file)?.audit || [row.file, ...(row.testInputs ?? [])].some(path => touched.has(path)) ? 'audit' : row.tier })) };
  return testsAtStage(files, effective, stage);
}
