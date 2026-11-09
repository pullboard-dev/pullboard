/**
 * The state materializer's worker thread: it builds each board's state as its reads ask, one build at a time,
 * extending the board's last build from its new events, and posts each build's materialized record [A2,C7].
 *
 * It saves each board's latest build to disk, keyed by the board, the code that built it and its last event id,
 * so a restarted server serves the saved record at once and its first build extends the saved one rather than
 * starting over. The snapshots live in the board's pullboard/state-cache folder, or PULLBOARD_STATE_CACHE_DIR.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
const { createStateSnapshots } = await import('./api.js');

/** How often, at most, a board's snapshot is saved while it keeps changing. */
const SAVE_EVERY_MS = 60_000;
const SNAPSHOT_VERSION = 1;
const CODE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

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
  return hash.digest('hex');
}

const { boardStatePorts } = await import(workerData.portsModule);
const ports = await boardStatePorts();
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

/** Where one board's snapshot lives, and the key a saved one must match. */
function snapshotFile(board) {
  const { cacheId, folder } = snapshots.snapshotPlace(board);
  const dir = process.env.PULLBOARD_STATE_CACHE_DIR || folder;
  return { cacheId, key: `${cacheId}\0${code}`, file: join(dir, createHash('sha256').update(cacheId).digest('hex').slice(0, 24) + '.snapshot') };
}

/** Serve a board's saved record at once and resume its builds from the saved build, when its key matches. */
function restoreSaved(message) {
  if (restored.has(message.key)) return;
  restored.add(message.key);
  try {
    const { key, file } = snapshotFile(message.board);
    const value = deserialize(readFileSync(file));
    if (value?.version !== SNAPSHOT_VERSION || value.key !== key) return;
    snapshots.restore(value.carry);
    parentPort.postMessage({ type: 'record', key: message.key, board: message.board, restored: true, record: { ...value.record, current: false } });
  } catch { /* No usable snapshot: the first build starts from the board itself. */ }
}

/** Save a board's latest build and record, through a temporary file so a reader never sees half of one. */
function save(board, record, { force = false } = {}) {
  const { cacheId, key, file } = snapshotFile(board);
  if (!force && Date.now() - (saved.get(cacheId)?.at ?? 0) < SAVE_EVERY_MS) return;
  const carry = snapshots.carry(cacheId);
  if (!carry) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, serialize({ version: SNAPSHOT_VERSION, key, board: { id: board.id, root: board.root }, sequence: record.sequence, carry, record }));
    renameSync(temporary, file);
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
    let names = [];
    try { names = readdirSync(folder).filter((name) => name.endsWith('.snapshot')); } catch { continue; }
    for (const name of names) {
      try {
        const value = deserialize(readFileSync(join(folder, name)));
        if (value?.version !== SNAPSHOT_VERSION || !value.board || value.key !== snapshotFile(value.board).key) continue;
        const key = value.board.id + '\0' + value.board.root;
        if (restored.has(key)) continue;
        restored.add(key);
        snapshots.restore(value.carry);
        parentPort.postMessage({ type: 'record', key, board: value.board, restored: true, record: { ...value.record, current: false } });
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
    const record = snapshots.materialize(message.board, { held: message.held, full: message.full });
    parentPort.postMessage({ type: 'record', id: message.id, key: message.key, record });
    latest.set(message.key, { board: message.board, record });
    save(message.board, record);
  } catch (error) {
    parentPort.postMessage({ type: 'error', id: message.id, key: message.key, error: errorFields(error) });
  }
});
