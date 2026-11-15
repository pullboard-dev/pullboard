/**
 * The submit gate's main-red lookup for a red frozen check [C7,#3424]: whether each failing case is red on main is read
 * from main's receipt, keyed by (main tree id, file, test command), through the drive cell's classifyGateRed. A file
 * with no receipt enqueues one main-test job on the board and is never measured here: no refresh process runs.
 */
import { classifyGateRed } from '../../../../../packages/drive/index.js';
import { mainRedLookup } from '../../../../../packages/drive/index.js';
import { mainReceipts } from '../../../../../packages/landing/index.js';
import { nearbyMainClass } from '../../../../../packages/landing/index.js';

/**
 * Classify a red frozen check's cases against main's receipts.
 *
 * Why: a refresh process that re-measures main on every red submit was load-bearing; a receipt is a fact about main's
 * content, so the gate reads it, and a missing one becomes a job any driver resumes rather than a wait inside submit.
 *
 * @param {{ root: string, db: import('node:sqlite').DatabaseSync, main: string,
 *   cases: { file: string, name: string, signature?: string }[], inputKeys?: Record<string, string>, now?: number }} request
 * @returns {{ comparison: { main: string, files: object[], receipts: string[] } | null,
 *   classes: ReturnType<typeof classifyGateRed>[], missing: string[], jobs: string[], reason: string }}
 *   `comparison` has compareMainFailures' detailed shape, built from main's receipts, and is null when any file lacks a
 *   receipt or main's tree or test command cannot be read; `reason` then says why. With no cases and `files`, it answers
 *   by file instead (mainFileReceipts).
 */
export function criterionMainReceipts({ root, db, main, cases, files: named = [], inputKeys = {}, now = Date.now() }) {
  if (!cases.length && named.length) return mainFileReceipts({ root, db, main, files: named, inputKeys, now });
  const byFile = new Map();
  for (const row of cases) byFile.set(row.file, [...(byFile.get(row.file) ?? []), row.name]);
  const files = [...byFile.keys()];
  // A receipt another main recorded under the same test input key answers for this main, and queues nothing [C7,SC11].
  const known = mainReceipts(root, main, files, { inputKeys });
  if (!known) return { comparison: null, classes: [], missing: files, jobs: [], reason: `main ${String(main).slice(0, 12)}'s tree or test command cannot be read, so no main receipt can be keyed` };
  const classes = files.map(file => {
    // A receipt on a later main where the file is unchanged answers for this main, and queues nothing [C7].
    const near = known.rows.has(file) ? null : nearbyMainClass(root, main, file, byFile.get(file));
    return near ? { file, ...near } : classifyGateRed(db, known.receipts, { tree: known.tree, file, command: known.command, reds: byFile.get(file), now });
  });
  const missing = classes.filter(row => row.owner === 'unknown').map(row => row.file);
  const jobs = classes.map(row => row.job).filter(Boolean);
  if (missing.length) return { comparison: null, classes, missing, jobs, reason: `main's receipt is missing for ${missing.join(', ')}; main-test job ${jobs.join(', ')} is queued, submit again once it records` };
  const comparison = { main, files: files.map(file => ({ file, ...(known.rows.get(file) ?? classes.find(row => row.file === file)?.row) })), receipts: classes.map(row => row.receipt) };
  return { comparison, classes, missing, jobs, reason: '' };
}

/**
 * Whether each failed file is red or green on main, from main's receipt for the whole file; a file with none enqueues
 * its main-test job and reads null. Why by file: a red whose reporter names no cases (Node's spec reporter) can only be
 * compared with main file by file, as the inline gate compared it [V1,C7].
 *
 * @param {{ root: string, db: import('node:sqlite').DatabaseSync, main: string, files: string[], inputKeys?: Record<string, string>, now?: number }} request
 * @returns {{ files: { file: string, result: 'red' | 'green' | null, receipt: string | null, job: string | null }[], jobs: string[], reason: string }}
 */
export function mainFileReceipts({ root, db, main, files, inputKeys = {}, now = Date.now() }) {
  const known = mainReceipts(root, main, files, { inputKeys });
  if (!known) return { files: [], jobs: [], reason: `main ${String(main).slice(0, 12)}'s tree or test command cannot be read, so no main receipt can be keyed` };
  const rows = files.map(file => {
    const found = mainRedLookup(db, known.receipts, { tree: known.tree, file, command: known.command, now });
    return { file, result: found.status === 'missing' ? null : found.status, receipt: found.receipt, job: found.job };
  });
  const jobs = rows.map(row => row.job).filter(Boolean);
  return { files: rows, jobs, reason: jobs.length ? `main-test job ${jobs.join(', ')} is queued, submit again once it records` : '' };
}
