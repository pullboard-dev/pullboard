/** Record a budget row for every test file the runner receipts measured over 120 s, so a lower default turns none red [C7]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { repoInfo } from '../../../../git/index.js';
import { testFileBudgetPath } from './file/policy.js';

/** A file at or under this many milliseconds gets no row. */
export const ROW_THRESHOLD_MS = 120_000;

/**
 * Latest measured milliseconds per test file, read from the shared runner receipt sidecars; a missing store means none are known.
 * Why: the budget rows record each file at its current time, and only the receipts hold what the runners measured.
 *
 * @param {string} root
 * @returns {Record<string, number>}
 */
export function latestRunnerFileTimes(root) {
  const directory = join(repoInfo(root).commonDir, 'pullboard', 'gate-receipts', 'test-value'), times = {};
  if (!existsSync(directory)) return times;
  const names = readdirSync(directory).filter(name => name.endsWith('.json'))
    .map(name => ({ name, at: statSync(join(directory, name)).mtimeMs })).sort((a, b) => a.at - b.at);
  for (const { name } of names) {
    let value;
    try { value = JSON.parse(readFileSync(join(directory, name), 'utf8')); } catch { continue; }
    if (value?.version !== 1 || !Array.isArray(value.files)) continue;
    for (const row of value.files) if (typeof row?.file === 'string' && Number.isFinite(row.durationMs) && row.durationMs >= 0) times[row.file] = row.durationMs;
  }
  return times;
}

/**
 * The rows to write: one per file over the threshold, ms the measured time rounded up, never above an existing row.
 * Why: a row may only be lowered, so a re-run after a faster measurement tightens a file and never loosens it [C7].
 *
 * @param {Record<string, number>} times - Latest measured milliseconds per test file.
 * @param {Record<string, number>} [existing] - Current row milliseconds per file.
 * @param {number} [threshold]
 * @returns {{ file: string, ms: number }[]} Sorted by file.
 */
export function budgetRows(times, existing = {}, threshold = ROW_THRESHOLD_MS) {
  const rows = [];
  for (const [file, measured] of Object.entries(times)) {
    if (!Number.isFinite(measured) || measured <= threshold) continue;
    const ms = Math.ceil(measured);
    rows.push({ file, ms: Object.hasOwn(existing, file) ? Math.min(existing[file], ms) : ms });
  }
  return rows.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** The rows already committed under .pullboard/test-file-budgets, by test file. */
export function existingRows(root) {
  const directory = join(root, '.pullboard', 'test-file-budgets'), rows = {};
  if (!existsSync(directory)) return rows;
  for (const name of readdirSync(directory).filter(entry => entry.endsWith('.json'))) {
    try {
      const value = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      if (value?.version === 1 && typeof value.file === 'string' && Number.isFinite(value.ms)) rows[value.file] = value.ms;
    } catch { /* A malformed row is the budget policy's to refuse, not this writer's. */ }
  }
  return rows;
}

/** Write the rows; a file already at its row keeps its bytes. Returns the files written. */
export function writeBudgetRows(root, rows) {
  const written = [];
  for (const { file, ms } of rows) {
    if (!existsSync(join(root, file))) continue;
    const path = join(root, testFileBudgetPath(file));
    const text = `${JSON.stringify({ version: 1, file, ms })}\n`;
    mkdirSync(join(path, '..'), { recursive: true });
    if (existsSync(path) && readFileSync(path, 'utf8') === text) continue;
    writeFileSync(path, text);
    written.push(file);
  }
  return written;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = resolve(process.argv[2] ?? '.');
  const rows = budgetRows(latestRunnerFileTimes(root), existingRows(root));
  const written = writeBudgetRows(root, rows);
  console.log(`${rows.length} test files over ${ROW_THRESHOLD_MS} ms; wrote ${written.length} budget rows`);
}
