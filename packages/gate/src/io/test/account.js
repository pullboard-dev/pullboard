/**
 * The account of test caching: per selected test file, whether it ran or reused a cached green, its action key, and on a
 * miss the first input that changed since the file's last key [C7].
 *
 * The planner (test-action-cache.js) keeps two small side stores in the shared test-action store: `parts/<inputKey>`
 * holds what one key hashed, by path and blob, and `last/<hash of file>` names the latest key each file had. A miss is
 * explained by comparing the two parts records. Everything here is advisory: an unreadable record says "unknown" and
 * never changes whether a file runs.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const REFERENCE_PARTS = 'parts-ref';
const FRAME = '# pullboard test cache ';
const SUMMARY = /^(?:# )?test cache: (\d+) files, (\d+) reused, (\d+) ran; top missed inputs: (.*)$/mu;

/** The hex sha256 of a string, used to name records without putting a path in a file name. */
function name(text) { return createHash('sha256').update(text).digest('hex'); }

/** Publish one JSON record by rename, so a reader sees the old record, the new one, or none. */
function publish(path, value) {
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Read one JSON record, or null when it is missing or unreadable. */
function load(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Keep one shared [path, blob] list under the store's `lists` folder, named by its own hash, and return that name.
 * Many parts of the same tree name the same list, so a part stays a few hundred bytes instead of the full file list [C7].
 *
 * @param {string} store the test-action store
 * @param {Array<[string, string|null]>} list
 * @returns {string} the list's name
 */
export function recordList(store, list) {
  const id = name(JSON.stringify(list));
  const directory = join(store, 'lists');
  const path = join(directory, `${id}.json`);
  try { statSync(path); return id; } catch { /* Not recorded yet. */ }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  publish(path, list);
  return id;
}

/** A part by input key: the by-reference record, or an inline one an older writer left under `parts`. */
function loadPart(store, inputKey) {
  return load(join(store, REFERENCE_PARTS, `${inputKey}.json`)) ?? load(join(store, 'parts', `${inputKey}.json`));
}

/** A part's list: the list itself in an older part, or the shared record a newer part names. Null when unreadable. */
function listOf(store, value) {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? load(join(store, 'lists', `${value}.json`)) : null;
}

/**
 * Keep what one input key hashed, once: the key is content-addressed, so an existing record is already right.
 * The file list and the runner list are stored once per distinct list and named by the part.
 *
 * @param {string} store the test-action store
 * @param {string} inputKey
 * @param {{ test: string, files: Array<[string, string|null]>, runner: Array<[string, string|null]>, inputs: Array<[string, string|null]>, tracked: string|null, options: string[] }} parts
 */
export function recordInputParts(store, inputKey, parts) {
  try {
    // By-reference parts live in their own folder: a reader built before shared lists reads only `parts` and expects inline arrays.
    const directory = join(store, REFERENCE_PARTS);
    const path = join(directory, `${inputKey}.json`);
    try { statSync(path); return; } catch { /* Not recorded yet. */ }
    const record = { ...parts, files: recordList(store, parts.files), runner: recordList(store, parts.runner) };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    publish(path, record);
  } catch { /* The account is advisory; a store that cannot be written costs only the explanation. */ }
}

/** The latest key record of a test file, or null when it never had one. */
export function latestKey(store, file) { return load(join(store, 'last', `${name(file)}.json`)); }

/** Remember a file's current key as its latest. */
export function rememberLatest(store, file, record) {
  try {
    mkdirSync(join(store, 'last'), { recursive: true, mode: 0o700 });
    publish(join(store, 'last', `${name(file)}.json`), record);
  } catch { /* Advisory, as above. */ }
}

/** The first path whose blob differs between two [path, blob] lists, in path order, or null. */
function firstPathDifference(before, now) {
  const left = new Map(Array.isArray(before) ? before : []), right = new Map(Array.isArray(now) ? now : []);
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    if (left.get(path) !== right.get(path)) return path;
  }
  return null;
}

/**
 * Name the first input that differs between a file's last key and its current key, in this order: the file itself, an
 * import in its closure, apps/cli/src/io/run/tests.js, package.json, any other runner file, a declared data input, the tracked list,
 * the run options, the Node version, then an environment variable.
 *
 * @param {string} store
 * @param {{ inputKey: string, context: object } | null} before the file's latest earlier key, if any
 * @param {{ inputKey: string, context: object }} now
 * @returns {string} `file`, `import <path>`, `apps/cli/src/io/run/tests.js`, `package.json`, `node`, `env <NAME>`, or a reason it is unknown
 */
export function firstChangedInput(store, before, now) {
  if (!before) return 'no earlier key';
  if (before.inputKey !== now.inputKey) {
    const first = loadPart(store, before.inputKey);
    const second = loadPart(store, now.inputKey);
    if (!first || !second) return 'unknown (earlier inputs not recorded)';
    const old = { ...first, files: listOf(store, first.files), runner: listOf(store, first.runner) };
    const current = { ...second, files: listOf(store, second.files), runner: listOf(store, second.runner) };
    for (const part of [old, current]) {
      if (![part.files, part.runner, part.inputs].every(Array.isArray)) return 'unknown (earlier inputs unreadable)';
    }
    const oldTest = old.files.find(([path]) => path === old.test)?.[1], newTest = current.files.find(([path]) => path === current.test)?.[1];
    if (oldTest !== newTest) return 'file';
    const imported = firstPathDifference(old.files, current.files);
    if (imported) return `import ${imported}`;
    const runner = firstPathDifference(old.runner, current.runner);
    if (runner) return runner;
    const read = firstPathDifference(old.inputs, current.inputs);
    if (read) return `input ${read}`;
    if (old.tracked !== current.tracked) return 'tracked file list';
    if (JSON.stringify(old.options) !== JSON.stringify(current.options)) return 'options';
  }
  const a = before.context ?? {}, b = now.context ?? {};
  if (a.node !== b.node) return 'node';
  const old = new Map(a.environment ?? []), current = new Map(b.environment ?? []);
  for (const variable of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    if (old.get(variable) !== current.get(variable)) return `env ${variable}`;
  }
  if (a.platform !== b.platform || a.arch !== b.arch) return 'platform';
  return 'none (no stored green for the key)';
}

/**
 * One summary line for a set of per-file rows: the file count, how many reused and ran, and the inputs that missed most.
 *
 * @param {Array<{ outcome: 'ran' | 'reused', missed: string | null }>} rows
 * @returns {string}
 */
export function cacheSummary(rows) {
  const counts = new Map();
  for (const row of rows) if (row.outcome === 'ran' && row.missed) counts.set(row.missed, (counts.get(row.missed) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([input, count]) => `${input} (${count})`);
  const reused = rows.filter(row => row.outcome === 'reused').length;
  return `test cache: ${rows.length} files, ${reused} reused, ${rows.length - reused} ran; top missed inputs: ${top.join(', ') || 'none'}`;
}

/**
 * The output text for per-file rows: one frame per file, then the summary line.
 *
 * @param {Array<{ file: string, outcome: string, key: string | null, missed: string | null }>} rows
 * @returns {string}
 */
export function formatCacheRows(rows) {
  return rows.map(row => `${FRAME}${JSON.stringify(row)}\n`).join('') + `# ${cacheSummary(rows)}\n`;
}

/**
 * Read the per-file rows and the summary line a run printed, or null when it printed none.
 *
 * @param {string} output
 * @returns {{ rows: object[], summary: string } | null}
 */
export function readCacheRows(output) {
  if (typeof output !== 'string') return null;
  const rows = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith(FRAME)) continue;
    try { rows.push(JSON.parse(line.slice(FRAME.length))); } catch { return null; }
  }
  const summary = SUMMARY.exec(output);
  return rows.length && summary ? { rows, summary: summary[0].replace(/^# /u, '') } : null;
}

/**
 * The profile fields for a run's cache account: the summary line and each file's row, or nothing when the run printed none.
 *
 * @param {string} output
 * @returns {{ testCache?: { summary: string, files: object[] } }}
 */
export function cacheProfile(output) {
  const read = readCacheRows(output);
  return read ? { testCache: { summary: read.summary, files: read.rows } } : {};
}
