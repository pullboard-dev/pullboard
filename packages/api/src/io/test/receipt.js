/**
 * A pulled `pullboard test --compare-main` runs main's side as a test job for one file under main's accepted focused
 * command. When its runner posts the receipt, the board keeps it as a native `main-red` gate receipt beside the board,
 * so the seat's notice can cite a receipt id the way the controller's comparison does [V4,B3,C7].
 *
 * Why the board writes it: the receipt binds main's tree, the accepted command's digest and the runner's own result,
 * read from the job row the runner posted; the seat that asked for the comparison never hands it a result to record.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { tryGit } from '../../../../git/index.js';
import { CONFIG_FILE } from '../../../../kernel/browser.js';
import { MAIN_FAILURE_SIGNATURE_VERSION } from '../../../../kernel/index.js';
import { receiptFields } from '../../../../verify/light.js';
import { offeredRequest } from '../jobs.js';
import { storeName } from '../store-names.js';

/** The job kind of a pulled test run, as the CLI offers it. */
const TEST_JOB_KIND = 'test';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
/** The reuse switch main's side runs under; mainFailureNotices accepts this spelling of the accepted command. */
export const MAIN_TEST_REUSE = 'PULLBOARD_TEST_REUSE=0';

/**
 * The receipt id the board gives a main-side test job's receipt: derived from the job id, so the seat that offered the
 * job finds it without another board row. Why derived: a job posts one recorded receipt, so one id per job is unique.
 *
 * @param {string} job
 * @returns {string} A UUID-shaped id.
 */
export function mainRedReceiptId(job) {
  const hex = createHash('sha256').update(`main-red:${job}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The exact command main's side of a compared test runs for one file: main's accepted focused command under the
 * reuse switch, the file quoted as the controller's comparison quotes it.
 *
 * @param {string} runner - main's accepted affectedTests.
 * @param {string} file - repository-relative test file.
 */
export function mainTestCommand(runner, file) {
  return `${MAIN_TEST_REUSE} ${runner.trimEnd()} '${('./' + file).replaceAll("'", "'\\''")}'`;
}

/** The receipt folder beside an open board file; null for a board with no file. */
function storeOf(board) {
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  return file ? join(dirname(file), 'gate-receipts') : null;
}

/** main's accepted focused test command, read from main's committed config; null when it names none. */
function acceptedRunner(root, main) {
  try {
    const shown = tryGit(root, ['show', `${main}:${CONFIG_FILE}`]);
    const runner = shown.status === 0 ? JSON.parse(shown.stdout).affectedTests : null;
    return typeof runner === 'string' && runner.trim() ? runner : null;
  } catch { return null; }
}

/**
 * The main-red receipt fields a posted main-side test receipt carries, or null when the job is not main's side of a
 * comparison of one file under the accepted command, or its result cannot be accounted for case by case.
 */
function mainRedFields(board, job, posted) {
  const row = board.db.prepare('SELECT job_kind, job_candidate, job_base FROM job WHERE job_id = ?').get(job);
  const data = row?.job_kind === TEST_JOB_KIND ? offeredRequest(board.db, job)?.input?.data : null;
  const main = data?.main;
  if (!SHA.test(String(main)) || data.source !== main || row.job_candidate !== main || row.job_base !== main
    || !Array.isArray(data.files) || data.files.length !== 1 || !board.gitRoot) return null;
  const [file] = data.files;
  const runner = acceptedRunner(board.gitRoot, main);
  if (!runner || data.command !== mainTestCommand(runner, file)) return null;
  const tree = tryGit(board.gitRoot, ['rev-parse', '--verify', `${main}^{tree}`]);
  const gate = posted.receipt?.gate;
  const phase = gate?.phases?.[0];
  if (tree.status !== 0 || !gate || gate.main !== main || gate.source !== main || !phase || !gate.load) return null;
  const green = posted.receipt.status === 0 && gate.green === true && phase.status === 0;
  // A red run that names no cases proves nothing case by case, so it leaves no receipt.
  if (!green && !Array.isArray(phase.failures)) return null;
  const failures = green ? [] : phase.failures.map(({ file: path, name }) => ({ file: path, name }));
  const signatures = !green && Array.isArray(phase.failureSignatures) && phase.failureSignatures.length === failures.length
    && phase.failureSignatures.every(value => DIGEST.test(String(value))) ? phase.failureSignatures : null;
  const wallMs = gate.steps?.test;
  return { version: 1, id: mainRedReceiptId(job), kind: 'main-red', tree: tree.stdout.trim(), head: main, main,
    command: createHash('sha256').update(data.command).digest('hex'), green, failures, load: gate.load,
    at: new Date().toISOString(), environment: gate.environment ?? null,
    ...(signatures ? { failureSignatures: { version: MAIN_FAILURE_SIGNATURE_VERSION, failures: failures.map((one, index) => ({ ...one, signature: signatures[index] })) } } : {}),
    full: false, timing: { version: 1, node: gate.environment?.node ?? null, wallMs, selectionMs: null, setupMs: null, shards: null, compareMs: wallMs } };
}

/**
 * Keep a posted main-side test receipt as a native main-red receipt beside the board; other test jobs stay recorded.
 * The file is written once: a second post of the same receipt finds the same bytes and leaves them.
 *
 * @param {any} board - The open board, gitRoot set to the board host's repository.
 * @param {{ job: string, receipt: Record<string, any> }} posted
 * @returns {{ applied: boolean, outcome: string, receiptId?: string }}
 */
export function applyTestReceipt(board, posted) {
  const receipt = receiptFields(mainRedFields(board, posted.job, posted));
  const folder = receipt ? storeOf(board) : null;
  if (!receipt || !folder) return { applied: false, outcome: 'recorded' };
  const body = `${JSON.stringify(receipt)}\n`;
  const path = join(folder, storeName(receipt.id));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try { writeFileSync(path, body, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || readFileSync(path, 'utf8') !== body) return { applied: false, outcome: 'recorded' };
  }
  return { applied: true, outcome: 'main-red', receiptId: receipt.id };
}
