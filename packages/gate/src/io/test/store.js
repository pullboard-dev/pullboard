/** Content-addressed test receipts exchanged only for the requested input keys [C7]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { testOutcomeFields } from './outcomes.js';
import { join } from 'node:path';
import {
  gzipSync,
  gunzipSync,
} from 'node:zlib';
import { storeName } from '../store-names.js';

export const TEST_RESULT_VERSION = 2;
export const TEST_RESULT_STORE_ENV = 'PULLBOARD_TEST_RESULT_STORE';
export const TEST_RESULT_ORIGIN_ENV = 'PULLBOARD_TEST_RESULT_ORIGIN';
export const TEST_RESULT_REQUEST_ENV = 'PULLBOARD_TEST_RESULT_REQUEST';
const HASH = /^[0-9a-f]{64}$/u;
// Cache data stays inside the existing one-MiB runner request budget. An oversized optional
// transfer is a cache miss, never a refused test or permission to truncate a proof.
const PACKED_BYTES = 384 * 1024;
const DECODED_BYTES = 8 * 1024 * 1024;

/** Hash a canonical value without including a machine path in its identity. */
export function testResultDigest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** Complete successful TAP attribution is required; an exit status alone proves nothing. */
export function validTestTap(report) {
  return report && Array.isArray(report.lines) && report.lines.every(line => typeof line === 'string'
    && !/[\r\n\0]/u.test(line) && /^\s*(?:not )?ok \d+(?: |$)/u.test(line))
    && report.counts && ['passed', 'failed', 'skipped', 'tests'].every(name => Number.isSafeInteger(report.counts[name]) && report.counts[name] >= 0)
    && report.counts.failed === 0 && report.observedTests === report.counts.tests
    && (report.testOutcomes === undefined || testOutcomeFields(report.testOutcomes) !== null);
}

/** Reuse case identity only from complete recorded Node outcomes, never inferred cached TAP or exit status. */
export function testResultOutcomes(entry) {
  if (!validTestTap(entry?.tap)) return null;
  const tests = testOutcomeFields(entry.tap.testOutcomes);
  const counts = entry.tap?.counts;
  if (!tests || tests.length !== counts.tests || tests.some(row => row.file !== entry.file)
    || tests.filter(row => row.passed && !row.skipped).length !== counts.passed
    || tests.filter(row => !row.passed && !row.skipped).length !== counts.failed
    || tests.filter(row => row.skipped).length !== counts.skipped + (counts.todo ?? 0)) return null;
  return tests;
}

/** Validate the record's key, source and origin before it can enter another machine's store. */
export function validTestResult(entry) {
  return entry?.version === TEST_RESULT_VERSION && HASH.test(entry.inputKey) && HASH.test(entry.key)
    && entry.context && typeof entry.context.node === 'string' && typeof entry.context.platform === 'string' && typeof entry.context.arch === 'string'
    && Array.isArray(entry.context.environment) && entry.context.environment.every(pair => Array.isArray(pair) && pair.length === 2
      && typeof pair[0] === 'string' && (pair[1] === null || typeof pair[1] === 'string'))
    && testResultDigest({ inputKey: entry.inputKey, context: entry.context }) === entry.key
    && typeof entry.file === 'string' && !entry.file.startsWith('/') && !entry.file.split('/').some(part => !part || part === '.' || part === '..')
    && /^[0-9a-f]{40,64}$/u.test(entry.commit) && typeof entry.stage === 'string' && typeof entry.at === 'string'
    && entry.origin && typeof entry.origin.machine === 'string' && typeof entry.origin.stage === 'string'
    && entry.origin.commit === entry.commit && entry.origin.stage === entry.stage && entry.origin.at === entry.at
    && (entry.origin.request === undefined || /^[a-f0-9-]{36}$/u.test(entry.origin.request))
    && (entry.origin.completion === undefined || completedTestResult(entry))
    && (entry.status === 'fail' || entry.status === 'pass' && validTestTap(entry.tap)
      && (entry.tap.testOutcomes === undefined || testResultOutcomes(entry) !== null));
}

/** Publish a whole record atomically, retaining private filesystem permissions. */
function publish(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

/** Merge one receipt. A red tombstone wins over every green, including a later imported one. */
export function storeTestResult(store, entry) {
  if (!validTestResult(entry)) return false;
  const directory = join(store, 'inputs', entry.inputKey);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(join(store, 'red'), { recursive: true, mode: 0o700 });
  mkdirSync(join(store, 'green'), { recursive: true, mode: 0o700 });
  if (entry.status === 'fail') {
    publish(join(store, 'red', entry.key), entry);
    publish(join(directory, storeName(entry.key)), entry);
    return true;
  }
  try { statSync(join(store, 'red', entry.key)); return false; } catch { /* Only never-red keys can be green. */ }
  // Keep the first completed origin; an unfinished worker cannot prevent a later real completion.
  try {
    const prior = JSON.parse(readFileSync(join(store, 'green', storeName(entry.key)), 'utf8'));
    if (validTestResult(prior) && prior.key === entry.key && prior.status === 'pass'
      && (prior.origin.completion || !entry.origin.request)
      && (!testResultOutcomes(entry) || testResultOutcomes(prior))) entry = prior;
  } catch { /* A missing or damaged entry is replaced by this complete receipt. */ }
  publish(join(store, 'green', storeName(entry.key)), entry);
  // A concurrent red is still authoritative at lookup, regardless of publication order.
  publish(join(directory, storeName(entry.key)), entry);
  return true;
}

/** Read only named input buckets; a full-store scan is never part of a transfer. */
export function selectedTestResults(store, inputKeys) {
  const records = [];
  for (const inputKey of new Set(inputKeys)) {
    if (!HASH.test(inputKey)) continue;
    let names;
    try { names = readdirSync(join(store, 'inputs', inputKey)); } catch { continue; }
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{64}\.json$/u.test(name)) continue;
      try {
        let entry = JSON.parse(readFileSync(join(store, 'inputs', inputKey, name), 'utf8'));
        // The tombstone remains authoritative if a green publish raced its bucket update.
        try { entry = JSON.parse(readFileSync(join(store, 'red', entry.key), 'utf8')); } catch { /* No local red. */ }
        if (validTestResult(entry) && entry.inputKey === inputKey && name === storeName(entry.key)) records.push(entry);
      } catch { /* Invalid data is a cache miss. */ }
    }
  }
  return records;
}

/** Bound optional transfer bytes independently of test output; all records remain whole. */
export function packTestResults(records) {
  try {
    const bytes = Buffer.from(JSON.stringify(records));
    if (bytes.length > DECODED_BYTES) return null;
    const packed = gzipSync(bytes);
    return packed.length <= PACKED_BYTES ? packed.toString('base64') : null;
  } catch { return null; }
}

/** Import only the input buckets the controller requested; invalid packets confer no cached pass. */
export function importTestResults(store, packet, inputKeys, completion = null) {
  if (typeof packet !== 'string' || packet.length > Math.ceil(PACKED_BYTES / 3) * 4) return 0;
  try {
    const rows = JSON.parse(gunzipSync(Buffer.from(packet, 'base64'), { maxOutputLength: DECODED_BYTES }).toString('utf8'));
    if (!Array.isArray(rows)) return 0;
    const allowed = new Set(inputKeys);
    let imported = 0;
    // Import reds first so a packet's order cannot temporarily promote a known-red key.
    for (const status of ['fail', 'pass']) for (const row of rows) {
      if (row?.status !== status || !allowed.has(row.inputKey)) continue;
      // A job that exited non-zero still vouches for a green whose own file process exited 0; every other row needs a zero job code [C7,#11103].
      if (completion && row.origin?.request === completion.id && row.commit === completion.commit
        && (completion.code === 0 || row.status === 'pass' && row.origin.fileExit === 0) && !completion.signal) row.origin.completion = completion;
      if (storeTestResult(store, row)) imported++;
    }
    return imported;
  } catch { return 0; }
}

/** A remote cache hit must cite a completed source-bound worker, never just its pre-execution request. */
export function completedTestResult(entry) {
  const receipt = entry?.origin?.completion;
  return receipt && /^[a-f0-9-]{36}$/u.test(receipt.id) && receipt.id === entry.origin.request
    && receipt.commit === entry.commit && /^[a-f0-9]{40,64}$/u.test(receipt.tree)
    && (receipt.code === 0 || entry.status === 'pass' && entry.origin.fileExit === 0) && !receipt.signal && HASH.test(receipt.outputSha256)
    && HASH.test(receipt.runtimeSha256) && HASH.test(receipt.toolingSha256);
}

/** Retain the actual authenticated completion before associating any cache green with its original receipt. */
export function retainTestResultCompletion(store, receipt) {
  const directory = join(store, 'completions');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, storeName(receipt.id));
  // This is the native protocol body as received, including its complete output digest and packet.
  try { writeFileSync(path, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || readFileSync(path, 'utf8') !== JSON.stringify(receipt) + '\n') throw error; }
  // Do not recursively embed cache packets in subsequent transfers.
  const { testResults, ...completion } = receipt;
  return completion;
}
