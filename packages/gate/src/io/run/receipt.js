/**
 * A gate run's own receipt [C7,D1]. The gate writes one file per real run of the accepted gate command on a clean,
 * committed tree, from the exit status and output of the process it ran: its tree, the command's digest, its result,
 * the committed tests that failed, and the host load. The file sits beside the board, under the git directory, so it
 * never enters a commit. This module reads and checks receipts; nothing here writes one. Only the gate's private
 * writer in gate.js does, right after its child exits, so no caller can hand it a result to record.
 */
import {
  dirname,
  join,
} from 'node:path';
import { checkoutCommonDir } from '../../../../git/index.js';
import { receiptFields } from '../../../../verify/light.js';
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
  // Git's own files name the shared directory without a process; Git answers when only it can (#5900).
  const common = checkoutCommonDir(root);
  return common ? join(common, 'pullboard', RECEIPT_FOLDER) : null;
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
    const text = fs.readFile(join(store, storeName(id)), 'utf8');
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

/** Exact native collection reports bind completion to one gate invocation [C7,V4]. */
export { COLLECTION_ID_ENV } from '../../logic/collection/env.js';
import { COLLECTION_ID_ENV } from '../../logic/collection/env.js';
import { storeName } from '../store-names.js';
import { fileSystemAdapter } from '../../../../fs/index.js';
const fs = fileSystemAdapter();
export { COLLECTION_REPORT_PREFIX, formatCollectionReport, parseCollectionReports } from '../../logic/collection/report.js';

/** A release explicitly requests every registered executor; ordinary landings keep their policy. */
export const RELEASE_EXECUTORS_ENV = 'PULLBOARD_RELEASE_EXECUTORS';
/** One invocation-bound observation, emitted by the shard controller after its actual children finish. */
export const RELEASE_PARTICIPATION_PREFIX = '# pullboard-release-participation ';

/** Read exactly one matching controller observation; a test's arbitrary output is never transport custody. */
export function releaseParticipation(output, id) {
  const matching = [];
  for (const line of String(output).split(/\r?\n/u)) {
    if (!line.startsWith(RELEASE_PARTICIPATION_PREFIX)) continue;
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) return null;
    let value;
    try { value = JSON.parse(line.slice(RELEASE_PARTICIPATION_PREFIX.length)); } catch { return null; }
    if (value?.id === id) matching.push(value);
  }
  return matching.length === 1 ? matching[0] : null;
}

/** Read the merged shard lines from a gate log into profile fields, or null for an unsharded run. */
export function landingShardProfile(output) {
  const shards = [];
  const files = [];
  let balance = null;
  let floor = null;
  const quarantined = [];
  const unverified = [];
  for (const line of String(output).split(/\r?\n/u)) {
    const plan = /^# landing shards: \d+ balanced by (history|history and average|file count) \(/u.exec(line);
    if (plan) balance = plan[1];
    const leftover = /^landing shard (\d+\/\d+): \[LANDING_SHARD_CLEANUP_UNVERIFIED\] the stopped shard's processes could not be shown gone: (.*); inspect/u.exec(line);
    if (leftover) unverified.push({ shard: leftover[1], processes: leftover[2] });
    const held = /^landing runner (\S+) quarantined for the rest of this landing: (.*)$/u.exec(line);
    if (held) quarantined.push({ host: held[1], message: held[2] });
    const slowest = /^# landing floor: (\d+) ms (.+)$/u.exec(line);
    if (slowest) floor = { path: slowest[2], ms: Number(slowest[1]) };
    // The optional trailing parenthetical is the shard's dispatch phases (connect, history, ready, run); the receipt keeps the wall time.
    const shard = /^# landing shard (\d+\/\d+) attempt (\d+) on (\S+): (green|red|stopped|infrastructure|refused)(?: \(([^)]*)\))? in (\d+) ms(?: \([^)]*\))?$/u.exec(line);
    if (shard) shards.push({ shard: shard[1], attempt: Number(shard[2]), host: shard[3], status: shard[4], reason: shard[5] ?? null, wallMs: Number(shard[6]) });
    const file = /^# landing file (\d+\/\d+) (\S+) (\d+|-) (.+)$/u.exec(line);
    if (file) files.push({ path: file[4], shard: file[1], host: file[2], durationMs: file[3] === '-' ? null : Number(file[3]) });
  }
  return shards.length ? { balance, floor, quarantined, unverified, shards, files } : null;
}

