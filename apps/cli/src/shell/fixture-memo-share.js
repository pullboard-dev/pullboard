/** Share the cells fixture-analysis memo between runners through the controller [C7]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { deserialize } from 'node:v8';
import { serialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';

/** A memo file is named by the fixture analyzer's digest, as bin/cells-plan.js names it. */
const NAME = /^[a-f0-9]{64}\.v8\.gz$/u;
/** Budget: a shared memo of at most 16 MiB compressed; tonight's were under 200 KiB. */
const MAX_BYTES = 16 * 1024 ** 2;
/** As many entries as one machine's memo keeps (cells-fixture-memo.js KEEP); the oldest leave first. */
const KEEP = 200_000;
/** How many of the newest stored memos a runner job carries: the current analyzer's and the one before it. */
const SHIPPED = 2;

/** The entries of a memo file's bytes, or null when they are not a well-formed memo. */
function memoEntries(bytes) {
  try {
    const data = deserialize(gunzipSync(bytes, { maxOutputLength: 512 * 1024 ** 2 }));
    if (data?.version !== 1 || !(data.entries instanceof Map) || data.entries.size > KEEP) return null;
    for (const [key, value] of data.entries) {
      if (typeof key !== 'string' || !Array.isArray(value?.reads) || !(value.result instanceof Uint8Array)) return null;
    }
    return data.entries;
  } catch { return null; } // Damaged bytes are no memo.
}

/** Replace one named memo file atomically. */
function publish(directory, name, bytes) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${name}.${process.pid}.tmp`);
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, join(directory, name));
}

/**
 * Union one carried memo ({ name, data: base64 }) into the memo stored under its name in `directory`; entries already
 * stored win. A malformed, oversized or misnamed memo changes nothing. Why: a change to the fixture analyzer renames the
 * memo on every runner, and each runner rebuilt the whole analysis on its next gate, 170-620 s; the entries are keyed by
 * file bytes, moves and the blobs each analysis read, so one runner's build serves every runner (#3981).
 *
 * @param {string} directory The memo folder: a runner's cells-cache/fixtures or the controller's store.
 * @param {{ name?: string, data?: string }|null|undefined} memo
 * @returns {boolean} True when the stored memo changed.
 */
export function absorbFixtureMemo(directory, memo) {
  if (typeof directory !== 'string' || !NAME.test(memo?.name ?? '') || typeof memo.data !== 'string' || memo.data.length > MAX_BYTES * 2) return false;
  const bytes = Buffer.from(memo.data, 'base64');
  const incoming = bytes.length <= MAX_BYTES ? memoEntries(bytes) : null;
  if (!incoming) return false;
  const file = join(directory, memo.name);
  const stored = existsSync(file) ? memoEntries(readFileSync(file)) : null;
  if (!stored) { publish(directory, memo.name, bytes); return true; }
  let added = 0;
  for (const [key, value] of incoming) if (!stored.has(key)) { stored.set(key, value); added += 1; }
  if (!added) return false;
  while (stored.size > KEEP) stored.delete(stored.keys().next().value);
  publish(directory, memo.name, gzipSync(serialize({ version: 1, entries: stored })));
  return true;
}

/**
 * The controller's store of shared memos, in this machine's home as gateMachineHome finds it (a machine or account home
 * isolates it in tests). Why here: this module is the runner job's import too, and may name no other cell.
 */
export function controllerMemoStore(env = process.env) {
  const home = env.PULLBOARD_MACHINE_HOME ? resolve(env.PULLBOARD_MACHINE_HOME) : join(resolve(env.PULLBOARD_ACCOUNT_HOME || homedir()), '.pullboard');
  return join(home, 'cells-cache', 'fixtures-shared');
}

/** Seed a runner's fixture memo from every carried memo; a failed seed only costs the analysis it would have saved. */
export function seedFixtureMemos(directory, memos) {
  for (const memo of Array.isArray(memos) ? memos : []) {
    try { absorbFixtureMemo(directory, memo); } catch { /* The cells check still runs, only slower. */ }
  }
}

/** The named memo files in a folder, newest first. */
function memoFiles(directory) {
  try {
    return readdirSync(directory).filter(name => NAME.test(name)).map(name => ({ name, at: statSync(join(directory, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at).map(row => row.name);
  } catch { return []; } // No folder yet holds no memo.
}

/** The newest stored memos as data a runner job carries; a file over the bound is left out. */
export function storedFixtureMemos(directory) {
  const memos = [];
  for (const name of memoFiles(directory).slice(0, SHIPPED)) {
    try {
      const bytes = readFileSync(join(directory, name));
      if (bytes.length <= MAX_BYTES) memos.push({ name, data: bytes.toString('base64') });
    } catch { /* A file removed meanwhile is simply not carried. */ }
  }
  return memos;
}

/** The newest memo in a runner's fixture cache as data for the controller, or null when it has none or cannot read it. */
export function newestFixtureMemo(directory) {
  try { return storedFixtureMemos(directory)[0] ?? null; } catch { return null; }
}

/**
 * A runner analysis job's memo share: seed its fixture memo from the carried memos now, and `collect` the newest memo
 * after the cells check for the controller. Null when main's cells cache cannot name the folder.
 */
export function runnerFixtureMemos(cellsCache, carried) {
  const directory = typeof cellsCache?.cellsCacheDirectory === 'function' ? cellsCache.cellsCacheDirectory('fixtures') : null;
  if (!directory) return null;
  seedFixtureMemos(directory, carried);
  return { collect: () => newestFixtureMemo(directory) };
}

/** Keep a runner job's returned memo in the controller's store and drop it from the result; a failed write is only a miss. */
export function keepRunnerFixtureMemo(value, directory = controllerMemoStore()) {
  if (!value || typeof value !== 'object' || !('fixtureMemo' in value)) return;
  try { absorbFixtureMemo(directory, value.fixtureMemo); } catch { /* The next job seeds from what the store holds. */ }
  delete value.fixtureMemo;
}
