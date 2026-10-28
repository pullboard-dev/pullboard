/**
 * A gate run's own receipt [C7,D1]. The gate writes one file per real run of the accepted gate command on a clean,
 * committed tree, from the exit status and output of the process it ran: its tree, the command's digest, its result,
 * the committed tests that failed, and the host load. The file sits beside the board, under the git directory, so it
 * never enters a commit. This module reads and checks receipts; nothing here writes one. Only the gate's private
 * writer in gate.js does, right after its child exits, so no caller can hand it a result to record.
 */
import { readFileSync } from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { tryGit } from './git.js';
import { receiptFields } from './proof-provenance.js';
export { receiptFields };

/** The folder beside the board that holds gate run receipts. */
export const RECEIPT_FOLDER = 'gate-receipts';
const ID = /^[a-f0-9-]{36}$/u;

/**
 * Where this checkout's gate keeps its receipts: the common git directory's pullboard folder, the same folder that
 * holds the board, so every worktree of one repo shares one store.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function receiptStore(root) {
  const common = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common.status === 0 ? join(common.stdout.trim(), 'pullboard', RECEIPT_FOLDER) : null;
}

/**
 * The receipt store beside an open board file, or null for a board with no file (an in-memory board has no gate).
 * The board finds it from its own database file, so no caller can point it at another folder.
 *
 * @param {{ db: any }} board
 * @returns {string | null}
 */
export function boardReceiptStore(board) {
  const file = board.db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
  return file ? join(dirname(file), RECEIPT_FOLDER) : null;
}

/**
 * The exact bytes a receipt is stored as. The board compares a run's receipt with these bytes on disk, so a run that
 * changes any field no longer matches the file its gate wrote.
 *
 * @param {object} receipt
 * @returns {string | null} null for a malformed receipt
 */
export function receiptBody(receipt) {
  const fields = receiptFields(receipt);
  return fields ? `${JSON.stringify(fields)}\n` : null;
}

/**
 * Read one stored receipt by id, or null when this store holds none or holds something else under that name.
 *
 * @param {string | null} store
 * @param {string} id
 * @returns {ReturnType<typeof receiptFields>}
 */
export function readGateReceipt(store, id) {
  if (!store || !ID.test(id ?? '')) return null;
  try {
    const text = readFileSync(join(store, `${id}.json`), 'utf8');
    const receipt = receiptFields(JSON.parse(text));
    return receipt && receiptBody(receipt) === text && receipt.id === id ? receipt : null;
  } catch { return null; }
}

/**
 * True only when the store holds the gate's own receipt for this run, byte for byte. A run made up by hand has no
 * such file, and a real receipt altered in any field no longer matches it.
 *
 * @param {string | null} store
 * @param {object} receipt
 * @returns {boolean}
 */
export function receiptBinds(store, receipt) {
  const stored = readGateReceipt(store, receipt?.id);
  return stored !== null && receiptBody(stored) === receiptBody(receipt);
}
