import { repoInfo } from '../../../../../git/index.js';
/** Private measured file runtimes keyed by the native receipt that observed them [C7]. */
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { storeName } from '../../store-names.js';

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
    const file = join(store, 'test-value', storeName(id));
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
    writeFileSync(join(directory, storeName(id)), body, { flag: 'wx', mode: 0o600 });
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


/** Each file's last measured samples, oldest first, as a census write kept them; none when the record holds none [C7]. */
export function readFileSamples(root) {
  try {
    const value = JSON.parse(readFileSync(fileTimesPath(root), 'utf8'));
    return Object.fromEntries(Object.entries(value?.samples ?? {}).filter(([, list]) => Array.isArray(list) && list.length && list.every(ms => Number.isFinite(ms) && ms >= 0)));
  } catch { return {}; }
}

/**
 * The record a census writes: only files in `keep` (the tracked test list), each measured file keeping its last two
 * samples and planned by the lower one. Why: per-file times swing 4-16x with runner load, so one loaded sample would
 * swell a job, and files gone from main would hold hundreds of planned minutes forever [C7].
 *
 * @param {Record<string, number>} files - The record's current plan weights.
 * @param {Record<string, number[]>} samples - The record's current samples, oldest first.
 * @param {Record<string, number>} measured - This census's per-file times.
 * @param {Iterable<string>} keep - Every file the census may keep.
 * @returns {{ version: 1, files: Record<string, number>, samples: Record<string, number[]> }}
 */
export function censusFileTimes(files, samples, measured, keep) {
  const record = { version: 1, files: {}, samples: {} };
  for (const file of new Set(keep)) {
    const ms = measured[file], prior = samples[file]?.at(-1) ?? files[file];
    const pair = Number.isFinite(ms) ? (Number.isFinite(prior) ? [prior, ms] : [ms]) : samples[file];
    if (pair) { record.samples[file] = pair; record.files[file] = Math.min(...pair); }
    else if (Number.isFinite(files[file])) record.files[file] = files[file];
  }
  return record;
}

/**
 * How many of `files` have a recorded wall time, how many there are, and the share recorded (0 to 1; 0 with no files).
 * Why: the push plan was sized from guesses when 144 of 2,502 files had a time, and nothing showed it [C7,#10330].
 *
 * @param {string} root - A checkout of the repository whose landing-file-times.json is read.
 * @param {string[]} files - The gate's test files; a leading ./ is ignored and a repeated file counts once.
 * @param {Record<string, number>} [times] - The recorded times, read from `root` when not given.
 * @returns {{ recorded: number, total: number, share: number }}
 */
export function fileTimesCoverage(root, files, times = readFileTimes(root)) {
  const list = [...new Set(files.map(file => file.replace(/^\.\//u, '')))];
  const recorded = list.filter(file => Number.isFinite(times[file])).length;
  return { recorded, total: list.length, share: list.length ? recorded / list.length : 0 };
}

/** The plan note for a coverage: "recorded N of M files", flagged when under 90 percent [C7,#10330]. */
export function fileTimesCoverageNote({ recorded, total, share }) {
  return `recorded ${recorded} of ${total} files${total && share < 0.9 ? ` (${Math.round(share * 100)} percent, under 90: the plan is sized from guesses)` : ''}`;
}
