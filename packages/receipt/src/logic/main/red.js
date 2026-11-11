/**
 * Main-red status as a keyed receipt lookup [C7]. Pure: whether a test file is red on main is a fact about content,
 * so it is keyed by main's tree id, the file and the test command, computed once by a main-test job and read here.
 * No process holds "current main reds"; a missing receipt is answered as missing so the caller can enqueue the job.
 */
import { Refused } from '../../../../kernel/light.js';

/** The job kind a missing main receipt enqueues; drive and landing share it so one key makes one job. */
export const MAIN_TEST_JOB = 'main-test';

/**
 * The id of the main-test job that writes the receipt for one key. Why: enqueueing is idempotent on this id, so every
 * gate or landing asking about one file at one main tree makes a single job.
 *
 * @param {string} key - a mainRedKey
 * @returns {string}
 */
export function mainTestJobId(key) {
  return `${MAIN_TEST_JOB}:${key}`;
}

/**
 * Main's status for one file read from a comparison row (`{ file, result, failures?, receiptId? }`), in the shape
 * mainRedStatus returns, so a caller holding a row classifies with classifyMainRed like one holding a receipt. With
 * `file`, only failing cases recorded under that file count. No row is a missing receipt.
 *
 * @param {object | null | undefined} row
 * @param {string} [file]
 * @returns {{ key: string | null, status: 'red' | 'green' | 'missing', receipt: string | null, failing: string[] }}
 */
export function comparisonStatus(row, file) {
  if (!row || !['red', 'green'].includes(row.result)) return { key: null, status: 'missing', receipt: null, failing: [] };
  const failing = row.result === 'red' ? (row.failures ?? []).filter((main) => !file || main.file === file).map((main) => main.name) : [];
  return { key: null, status: row.result, receipt: row.receiptId ?? null, failing };
}

/**
 * The key a main-test receipt is stored and read by: main's tree, the test file and the project's test command.
 *
 * @param {string} tree - tree id of main
 * @param {string} file - test file path, relative to the repository root
 * @param {string} command - the test command the runner ran for that file
 * @returns {string}
 */
export function mainRedKey(tree, file, command) {
  for (const [name, value] of [['tree', tree], ['file', file], ['command', command]]) {
    if (typeof value !== 'string' || !value) {
      throw new Refused('MAIN_RED_KEY', `a main-red key needs main's tree id, the test file and the test command; pass ${name}.`);
    }
  }
  return `${tree}:${file}:${command}`;
}

/**
 * Read a main-test receipt by key from a list or map of receipts. A receipt is
 * `{ id, tree, file, command, verdict: 'green' | 'red', failing?: string[] }`.
 *
 * @param {Iterable<object> | Map<string, object>} receipts
 * @param {string} key
 * @returns {object | null}
 */
export function mainReceiptByKey(receipts, key) {
  if (receipts instanceof Map) return receipts.get(key) ?? null;
  for (const receipt of receipts ?? []) if (mainRedKey(receipt.tree, receipt.file, receipt.command) === key) return receipt;
  return null;
}

/**
 * Whether a test file is red on main, answered from its receipt alone.
 *
 * @param {Iterable<object> | Map<string, object>} receipts
 * @param {{ tree: string, file: string, command: string }} at
 * @returns {{ key: string, status: 'red' | 'green' | 'missing', receipt: string | null, failing: string[] }}
 */
export function mainRedStatus(receipts, { tree, file, command }) {
  const key = mainRedKey(tree, file, command);
  const receipt = mainReceiptByKey(receipts, key);
  if (!receipt) return { key, status: 'missing', receipt: null, failing: [] };
  const status = receipt.verdict === 'red' ? 'red' : 'green';
  return { key, status, receipt: receipt.id ?? key, failing: status === 'red' ? [...(receipt.failing ?? [])] : [] };
}

/**
 * Classify a gate's reds in one file against main's receipt for that file. Reds that are all red in main's receipt
 * are main's own red, carrying the receipt id; any red main's receipt does not name is the candidate's own; with no
 * receipt the answer is unknown until the main-test job writes one.
 *
 * @param {string[]} reds - failing case titles in the gate's run of the file
 * @param {ReturnType<typeof mainRedStatus>} main - main's status for the same file and command
 * @returns {{ owner: 'main' | 'candidate' | 'unknown', receipt: string | null, own: string[], code: string | null }}
 */
export function classifyMainRed(reds, main) {
  if (!Array.isArray(reds) || reds.length === 0) {
    throw new Refused('MAIN_RED_REDS', 'classifyMainRed needs the failing case titles from the gate run; pass a non-empty list.');
  }
  if (!main || main.status === 'missing') return { owner: 'unknown', receipt: null, own: [...reds], code: 'MAIN_RECEIPT_MISSING' };
  const onMain = new Set(main.status === 'red' ? main.failing : []);
  const own = reds.filter((title) => !onMain.has(title));
  if (own.length === 0) return { owner: 'main', receipt: main.receipt, own: [], code: 'MAIN_OWN_RED' };
  return { owner: 'candidate', receipt: main.receipt, own, code: 'CANDIDATE_RED' };
}
