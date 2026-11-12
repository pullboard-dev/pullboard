/**
 * The submit gate's main-red lookup for a red frozen check [C7,#3424]: whether each failing case is red on main is read
 * from main's receipt, keyed by (main tree id, file, test command), through the drive cell's classifyGateRed. A file
 * with no receipt enqueues one main-test job on the board and is never measured here: no refresh process runs.
 */
import { classifyGateRed } from '../../../../../packages/drive/index.js';
import { mainReceipts } from '../../../../../packages/landing/index.js';
import { nearbyMainReceipts } from '../../../../../packages/landing/index.js';
import { mainRedStatus } from '../../../../../packages/receipt/index.js';
import { classifyMainRed } from '../../../../../packages/receipt/index.js';

/**
 * Classify a red frozen check's cases against main's receipts.
 *
 * Why: a refresh process that re-measures main on every red submit was load-bearing; a receipt is a fact about main's
 * content, so the gate reads it, and a missing one becomes a job any driver resumes rather than a wait inside submit.
 *
 * @param {{ root: string, db: import('node:sqlite').DatabaseSync, main: string,
 *   cases: { file: string, name: string, signature?: string }[], now?: number }} request
 * @returns {{ comparison: { main: string, files: object[], receipts: string[] } | null,
 *   classes: ReturnType<typeof classifyGateRed>[], missing: string[], jobs: string[], reason: string }}
 *   `comparison` has compareMainFailures' detailed shape, built from main's receipts, and is null when any file lacks a
 *   receipt or main's tree or test command cannot be read; `reason` then says why.
 */
export function criterionMainReceipts({ root, db, main, cases, now = Date.now() }) {
  const byFile = new Map();
  for (const row of cases) byFile.set(row.file, [...(byFile.get(row.file) ?? []), row.name]);
  const files = [...byFile.keys()];
  const known = mainReceipts(root, main, files);
  if (!known) return { comparison: null, classes: [], missing: files, jobs: [], reason: `main ${String(main).slice(0, 12)}'s tree or test command cannot be read, so no main receipt can be keyed` };
  const classes = files.map(file => {
    const at = { tree: known.tree, file, command: known.command };
    // A receipt on a later main where the file is unchanged answers for this main, and queues nothing [C7].
    const near = mainRedStatus(known.receipts, at).status === 'missing' ? nearbyMainReceipts(root, main, file) : null;
    if (!near) return classifyGateRed(db, known.receipts, { ...at, reds: byFile.get(file), now });
    return { file, ...classifyMainRed(byFile.get(file), mainRedStatus(near.receipts, { tree: near.tree, file, command: near.command })), job: null };
  });
  const missing = classes.filter(row => row.owner === 'unknown').map(row => row.file);
  const jobs = classes.map(row => row.job).filter(Boolean);
  if (missing.length) return { comparison: null, classes, missing, jobs, reason: `main's receipt is missing for ${missing.join(', ')}; main-test job ${jobs.join(', ')} is queued, submit again once it records` };
  const comparison = { main, files: files.map(file => ({ file, ...(known.rows.get(file) ?? nearbyMainReceipts(root, main, file)?.rows.get(file)) })), receipts: classes.map(row => row.receipt) };
  return { comparison, classes, missing, jobs, reason: '' };
}
