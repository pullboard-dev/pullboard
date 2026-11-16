/** @pullboard-module-loads apps/cli/src/io/commands/serve.js */
/**
 * The state materializer's worker thread: it builds each board's state as its reads ask, one build at a time,
 * extending the board's last build from its new events, and posts each build's materialized record [A2,C7].
 *
 * It saves each board's latest build to disk, keyed by the board, the code that built it and its last event id,
 * so a restarted server serves the saved record at once and its first build extends the saved one rather than
 * starting over. The serve command hands it the store that keeps them (the pin cell's keyed results), in the board's
 * state-cache folder or PULLBOARD_STATE_CACHE_DIR; a snapshot from other code fails its key and is rebuilt. Without
 * a store, nothing is saved.
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize } from 'node:v8';
import { serialize } from 'node:v8';
import { parentPort } from 'node:worker_threads';
import { workerData } from 'node:worker_threads';

// Node 22 announces that node:sqlite is experimental; the request thread drops that notice, and so does this one,
// before the board modules load: why they are imported below rather than hoisted.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};
const { createStateSnapshots } = await import('../../main.js');

/** How often, at most, a board's snapshot is saved while it keeps changing. */
const SAVE_EVERY_MS = 60_000;
const SNAPSHOT_VERSION = 1;
const CODE_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

/**
 * Name the code this worker runs: a digest of every source file's path, size and modification time. Why not
 * Git: an installed package has no repository, and a worktree's uncommitted edits change what a build means.
 */
function codeStamp(formats) {
  const hash = createHash('sha256').update(`${SNAPSHOT_VERSION}:${formats}`);
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); } catch { return; }
    for (const entry of names) {
      if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:[cm]?js|json|md)$/u.test(entry.name)) {
        const stat = statSync(path);
        hash.update(`${path.slice(CODE_ROOT.length)}:${stat.size}:${stat.mtimeMs}\n`);
      }
    }
  };
  for (const top of ['apps', 'packages', 'src']) walk(join(CODE_ROOT, top));
  // The release version and notes come from these two files and sit in every built state, so a new release must miss.
  for (const name of ['package.json', 'CHANGELOG.md']) {
    try { const stat = statSync(join(CODE_ROOT, name)); hash.update(`${name}:${stat.size}:${stat.mtimeMs}\n`); } catch { /* An install without the file has nothing to stamp. */ }
  }
  return hash.digest('hex');
}

const { boardStatePorts } = await import(workerData.portsModule);
const ports = await boardStatePorts();
const store = ports.snapshotStore ?? null;
let projects = workerData.projects ?? [];
const snapshots = createStateSnapshots({
  projects: () => projects, scope: workerData.scope, isMain: workerData.isMain,
  boardOpeners: ports.boardOpeners, viewPorts: ports.viewPorts,
  onStateBuild: (build) => parentPort.postMessage({ type: 'build', ...build }),
});
const code = codeStamp(snapshots.formats);
/** The boards whose saved snapshot was already looked for, and when each was last saved. */
const restored = new Set();
const saved = new Map();

/** Where one board's snapshot lives: its folder, the board's cache id that names it, and the key a saved one must match. */
function snapshotFile(board) {
  const { cacheId, folder } = snapshots.snapshotPlace(board);
  return { cacheId, key: `${cacheId}\0${code}`, folder: process.env.PULLBOARD_STATE_CACHE_DIR || folder };
}

/** The record fields a read of any variant needs, so a snapshot of other code is served only when it has them all. */
const SERVED_FIELDS = ['summary', 'compact', 'open', 'finished', 'search', 'shouts', 'deltas', 'reportValidator', 'sequence'];

/**
 * Restore one decoded snapshot and post its record, when it was saved for this board. One saved by this code resumes its builds;
 * one saved by other code (a landing changed a source file) is only served to kept reads until the full build by this code lands,
 * so the first load of a restarted server never waits out a rebuild of the whole board [C7,#8471].
 */
function restoreValue(value, board) {
  if (value?.version !== SNAPSHOT_VERSION || !board) return;
  const { key: wanted, cacheId } = snapshotFile(board);
  const exact = value.key === wanted;
  // Other code's record must be of this board and these formats (never an older schema or event log) and carry every field a read joins.
  if (!exact && !(typeof value.key === 'string' && value.key.startsWith(`${cacheId}\0`) && value.formats === snapshots.formats && SERVED_FIELDS.every(field => value.record?.[field] != null))) return;
  const key = board.id + '\0' + board.root;
  if (restored.has(key)) return;
  restored.add(key);
  if (exact) snapshots.restore(value.carry);
  parentPort.postMessage({ type: 'record', key, board, restored: true, record: { ...value.record, current: false, ...(exact ? {} : { revision: null }) } });
}

/** Serve a board's saved record at once and resume its builds from the saved build, when its key matches. */
function restoreSaved(message) {
  if (restored.has(message.key)) return;
  try {
    const { cacheId, folder } = snapshotFile(message.board);
    const bytes = store?.load(folder, cacheId);
    if (bytes) restoreValue(deserialize(bytes), message.board);
  } catch { /* No usable snapshot: the first build starts from the board itself. */ }
  restored.add(message.key);
}

/** Save a board's latest build and record as the pin cell's result for that board. */
function save(board, record, { force = false } = {}) {
  const { cacheId, key, folder } = snapshotFile(board);
  if (!force && Date.now() - (saved.get(cacheId)?.at ?? 0) < SAVE_EVERY_MS) return;
  const carry = snapshots.carry(cacheId);
  if (!carry || !store) return;
  try {
    store.save(folder, cacheId, serialize({ version: SNAPSHOT_VERSION, key, formats: snapshots.formats, board: { id: board.id, root: board.root }, sequence: record.sequence, carry, record }));
    saved.set(cacheId, { at: Date.now(), board, record, sequence: record.sequence });
  } catch { /* A snapshot only speeds the next start; failing to save one never fails a build. */ }
}

/** The fields of an error the request thread rebuilds it from. */
function errorFields(error) {
  return { name: error?.name, code: error?.code, message: error?.message ?? String(error), next: error?.next, stack: error?.stack };
}

/**
 * Load every registered board's saved snapshot as the worker starts, before any read asks: why a restarted server's
 * first read is served from memory rather than waiting on the worker to load and decode a large file.
 */
function prewarm() {
  const folders = new Set();
  for (const project of projects) {
    try { folders.add(process.env.PULLBOARD_STATE_CACHE_DIR || snapshots.snapshotPlace({ id: '', root: project.root }).folder); } catch { /* An unreadable project has no snapshot. */ }
  }
  for (const folder of folders) {
    for (const bytes of store?.saved(folder) ?? []) {
      try {
        const value = deserialize(bytes);
        restoreValue(value, value?.board);
      } catch { /* No usable snapshot: that board's first build starts from the board itself. */ }
    }
  }
}
prewarm();

const latest = new Map();
parentPort.on('message', (message) => {
  if (message.type === 'close') {
    for (const { board, record } of latest.values()) {
      const { cacheId } = snapshotFile(board);
      if (saved.get(cacheId)?.sequence !== record.sequence) save(board, record, { force: true });
    }
    process.exit(0);
  }
  if (message.type !== 'build') return;
  if (Array.isArray(message.projects)) projects = message.projects;
  restoreSaved(message);
  try {
    // The revision the request thread read before asking: the build saw at least that state, so a read finding it serves this record.
    const record = { ...snapshots.materialize(message.board, { held: message.held, full: message.full }), revision: message.revision ?? null };
    parentPort.postMessage({ type: 'record', id: message.id, key: message.key, record });
    latest.set(message.key, { board: message.board, record });
    save(message.board, record);
  } catch (error) {
    parentPort.postMessage({ type: 'error', id: message.id, key: message.key, error: errorFields(error) });
  }
});
