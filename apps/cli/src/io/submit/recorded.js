/**
 * A red gate's comparison with main read from main's recorded results first [C7,#5813]: each failing file with a
 * complete recorded result at the exact main commit (main's receipts in .git/pullboard/main-red.json) is answered from
 * it, and only the files with none are run on main.
 */
import { compareMainFailures } from '../../../../../packages/landing/index.js';
import { failingFiles } from '../../../../../packages/landing/index.js';
import { mainReceipts } from '../../../../../packages/landing/index.js';

/**
 * Compare a red gate's failing files with main, as compareMainFailures does and in its detailed result shape, but
 * running only the files main has no recorded result for at `options.commit`.
 *
 * Why: re-running already-measured red files on main cost a gate 260 s median on 22% of gates; a recorded result at the
 * same main commit is the board's fact about that file, so nothing new needs to run for it.
 *
 * @param {string} root
 * @param {object} profile - the red phase's parsed test profile
 * @param {(state: object) => void} [onWait]
 * @param {string} [output] - the red phase's reporter output
 * @param {Parameters<typeof compareMainFailures>[4]} [options] - commit: main's exact commit
 * @param {{ compare?: typeof compareMainFailures }} [ports] - the main runner; a test may watch which files it is asked to run.
 * @returns {Promise<{ main: string | null, files: object[], recorded?: string[], unavailable?: string }>} recorded: the
 *   files answered from main's recorded results without a run.
 */
export async function recordedMainComparison(root, profile, onWait, output = '', options = {}, { compare = compareMainFailures } = {}) {
  const run = () => compare(root, profile, onWait, output, options);
  if (!options.commit) return run();
  let files, known;
  try {
    files = failingFiles(root, profile, output);
    known = files.length ? mainReceipts(root, options.commit, files) : null;
  } catch { return run(); }
  const recorded = known ? files.filter(file => known.rows.has(file)) : [];
  if (!recorded.length) return run();
  for (const file of recorded) {
    const receiptId = known.rows.get(file).receiptId;
    if (receiptId && options.onMeasuredReceipt) try { await options.onMeasuredReceipt(receiptId); } catch { /* Receipt retention never changes the verdict. */ }
  }
  const missing = files.filter(file => !known.rows.has(file));
  const measured = missing.length
    ? await compare(root, { tests: missing.map(file => ({ file, passed: false })) }, onWait, '', options)
    : { main: options.commit, files: [] };
  if (measured.unavailable) return measured;
  const byFile = new Map((measured.files ?? []).map(row => [row.file, row]));
  for (const file of recorded) byFile.set(file, { file, ...known.rows.get(file) });
  return { main: options.commit, files: files.filter(file => byFile.has(file)).map(file => byFile.get(file)), recorded };
}
