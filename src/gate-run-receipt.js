/**
 * A gate run's own receipt [C7,D1]. The gate writes one file per real run of the accepted gate command on a clean,
 * committed tree, from the exit status and output of the process it ran: its tree, the command's digest, its result,
 * the committed tests that failed, and the host load. The file sits beside the board, under the git directory, so it
 * never enters a commit. This module reads and checks receipts; nothing here writes one. Only the gate's private
 * writer in gate.js does, right after its child exits, so no caller can hand it a result to record.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { tryGit } from './git.js';
import { proofFields } from './proof-provenance.js';
import { environmentProblem } from './execution-environment.js';

/** The folder beside the board that holds gate run receipts. */
export const RECEIPT_FOLDER = 'gate-receipts';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[a-f0-9-]{36}$/u;
const MOST_FAILURES = 500;
const MOST_COLLECTION_FILES = 100000;

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

/** Bounded single-line text, so a receipt never carries a log or a path outside the repo. */
function line(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\r\n\0]/u.test(value);
}

/**
 * Check and normalize a receipt's fields, in one fixed key order, or null when any field is missing or malformed. A
 * green run names no failure; a red run names the committed tests it could identify. It never throws: the gate's writer
 * must not fail a run over its receipt, and the board names its own refusal.
 *
 * @param {any} value
 * @returns {object | null} A canonical legacy gate or native proof receipt.
 */
export function receiptFields(value) {
  try { return checkedFields(value); } catch { return null; }
}

/** Validate observed collection coverage independently from green/red gate quality. */
function collectionFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.mode !== 'all'
    || !/^[a-zA-Z0-9_-]{1,80}$/u.test(value.batchId ?? '')
    || typeof value.complete !== 'boolean' || typeof value.full !== 'boolean'
    || !Array.isArray(value.files) || value.files.length > MOST_COLLECTION_FILES
    || value.files.some(file => !line(file, 4096) || file.startsWith('/') || /^[a-zA-Z]:/u.test(file)
      || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..'))
    || !Number.isSafeInteger(value.plannedFiles) || value.plannedFiles < 0
    || !Number.isSafeInteger(value.completedFiles) || value.completedFiles < 0
    || !DIGEST.test(value.planDigest ?? '') || !DIGEST.test(value.completedDigest ?? '')) throw new TypeError('malformed collection receipt');
  const files = [...value.files].sort();
  if (files.length !== value.plannedFiles || new Set(files).size !== files.length
    || JSON.stringify(files) !== JSON.stringify(value.files)
    || createHash('sha256').update(JSON.stringify(files)).digest('hex') !== value.planDigest) throw new TypeError('collection plan does not match explicit files');
  if (value.complete && !(value.plannedFiles > 0 && value.plannedFiles === value.completedFiles
    && value.planDigest === value.completedDigest)) throw new TypeError('incomplete collection cannot claim completeness');
  return { version: 1, mode: 'all', batchId: value.batchId, full: value.full, files, complete: value.complete,
    plannedFiles: value.plannedFiles, completedFiles: value.completedFiles,
    planDigest: value.planDigest, completedDigest: value.completedDigest };
}

/** The checks behind receiptFields; each malformed field throws, and receiptFields turns that into null. */
function checkedFields(value) {
  const bad = () => new TypeError('malformed gate receipt');
  if (Object.hasOwn(value ?? {}, 'environment') && value.environment !== null && environmentProblem(value.environment)) throw bad();
  const proof = value?.version === 2 ? proofFields(value.proof) : null;
  const version = value?.version;
  const hasCollection = Object.hasOwn(value ?? {}, 'collection');
  if (hasCollection && (version !== 1 || !['land', 'release'].includes(value.kind))) throw bad();
  const collection = hasCollection ? collectionFields(value.collection) : null;
  const kinds = version === 2 ? ['check', 'submit', 'verdict'] : ['gate', 'land', 'submit', 'release'];
  if (!value || ![1, 2].includes(version) || version === 2 && !proof || !ID.test(value.id ?? '') || !kinds.includes(value.kind)
    || !(version === 2 && value.tree === null) && !SHA.test(value.tree ?? '')
    || !(version === 2 && value.head === null) && !SHA.test(value.head ?? '')
    || value.main !== null && !SHA.test(value.main ?? '') || !DIGEST.test(value.command ?? '')
    || typeof value.green !== 'boolean' || !Array.isArray(value.failures) || value.failures.length > MOST_FAILURES
    || value.green && value.failures.length > 0 || !line(value.at, 40) || !Number.isFinite(Date.parse(value.at))) throw bad();
  const failures = value.failures.map((entry) => {
    const file = entry?.file, name = entry?.name;
    if (!line(file, 4096) || file.startsWith('/') || file.includes('\\') || file.split('/').some((part) => !part || part === '.' || part === '..') || !line(name, 8192)) throw bad();
    return { file, name };
  });
  const load = value.load;
  if (!(version === 2 && load === null) && (!load || !Array.isArray(load.average) || load.average.length !== 3 || load.average.some((number) => !Number.isFinite(number) || number < 0)
    || !Number.isSafeInteger(load.cpus) || load.cpus < 1 || !Number.isSafeInteger(load.freeMB) || load.freeMB < 0)) throw bad();
  return { version, id: value.id, kind: value.kind, tree: value.tree, head: value.head, main: value.main, command: value.command,
    green: value.green, failures, load: load === null ? null : { average: [...load.average], cpus: load.cpus, freeMB: load.freeMB }, at: value.at,
    ...(proof ? { proof } : {}), ...(Object.hasOwn(value, 'environment') ? { environment: value.environment } : {}),
    ...(hasCollection ? { collection } : {}) };
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
