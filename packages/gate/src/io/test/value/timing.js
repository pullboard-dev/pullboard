import { repoInfo } from '../../../../../git/index.js';
/** Private measured file runtimes keyed by the native receipt that observed them [C7]. */
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const RECEIPT_ID = /^[a-f0-9-]{36}$/u;
const MAX_FILES = 20_000;
const MAX_TESTS = 100_000;
const MAX_BYTES = 16 * 1024 * 1024;

/** Accept portable selected-file names, never absolute paths or traversal. */
function portableFile(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/^[A-Za-z]:/u.test(value) && !/[\\\0\r\n]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Validate one actual file measurement without deriving runtime from tests or wall time. */
function measuredRow(file, durationMs) {
  return portableFile(file) && Number.isFinite(durationMs) && durationMs >= 0
    ? { file, durationMs } : null;
}

/** Retain only explicit executed outcomes; the caller excludes skips, todos and aggregate results. */
function measuredTest(value) {
  return portableFile(value?.file) && typeof value.name === 'string' && value.name.length > 0
    && value.name.length <= 8192 && !/[\0\r\n]/u.test(value.name) && typeof value.passed === 'boolean'
    ? { file: value.file, name: value.name, passed: value.passed } : null;
}

/** Read a bounded immutable timing sidecar; absent or malformed measurements remain unknown. */
export function readTestValueTimings(store, id) {
  try {
    if (typeof store !== 'string' || !RECEIPT_ID.test(id ?? '')) return null;
    const file = join(store, 'test-value', `${id}.json`);
    if (statSync(file).size > MAX_BYTES) return null;
    const bytes = readFileSync(file);
    if (bytes.length > MAX_BYTES) return null;
    const value = JSON.parse(bytes.toString('utf8'));
    if (value?.version !== 1 || value.receiptId !== id || !Array.isArray(value.files)
      || value.files.length > MAX_FILES) return null;
    const files = value.files.map(row => measuredRow(row?.file, row?.durationMs));
    const rawTests = Object.hasOwn(value, 'tests') ? value.tests : [];
    if (!Array.isArray(rawTests) || rawTests.length > MAX_TESTS) return null;
    const tests = rawTests.map(measuredTest);
    return files.every(Boolean) && tests.every(Boolean) ? { version: 1, receiptId: id, files, tests } : null;
  } catch { return null; }
}

/** Retain measured rows once; metrics failures never change the native proof result. */
export function retainTestValueTimings(store, id, profile) {
  try {
    if (typeof store !== 'string' || !RECEIPT_ID.test(id ?? '')) return false;
    const rows = Array.isArray(profile?.landingShards?.files) ? profile.landingShards.files : profile?.files;
    if (!Array.isArray(rows) || rows.length > MAX_FILES) return false;
    const files = rows.map(row => measuredRow(row?.path, row?.durationMs)).filter(Boolean);
    const rawTests = profile && Object.hasOwn(profile, 'tests') ? profile.tests : [];
    if (!Array.isArray(rawTests) || rawTests.length > MAX_TESTS) return false;
    const tests = rawTests.map(measuredTest).filter(Boolean);
    const body = `${JSON.stringify({ version: 1, receiptId: id, files, tests })}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) return false;
    const directory = join(store, 'test-value');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, `${id}.json`), body, { flag: 'wx', mode: 0o600 });
    return true;
  } catch { return false; }
}

/** Where the last landing's per-file wall times live, shared by every worktree of the repository. */
export function fileTimesPath(root) {
  return join(repoInfo(root).commonDir, 'pullboard', 'landing-file-times.json');
}

/** Read the last per-file wall times; a missing or unreadable record means none are known. */
export function readFileTimes(root) {
  try {
    const value = JSON.parse(readFileSync(fileTimesPath(root), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value.files ?? {}).filter(([, ms]) => Number.isFinite(ms) && ms >= 0));
  } catch { return {}; }
}

