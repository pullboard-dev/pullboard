/** Finished submit-handoff folders are pruned by the dispatcher loop, never by a person or agent command [C7]. */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  dirname,
  join,
} from 'node:path';
import { machineHome } from '../home.js';

/** How long a handoff folder stays after its gate ended: 30 minutes. */
export const HANDOFF_FOLDER_KEEP_MS = 30 * 60_000;

/** The most folders removed in one pass, so a backlog drains without a burst of file churn. */
export const HANDOFF_PRUNE_BATCH = 25;

/** Where the dispatcher remembers every submit-handoffs root it has seen, so a later dispatcher sweeps them too. */
function rootsFile() { return join(machineHome(), 'handoff-queue', 'prune-roots'); }

/**
 * Remember the submit-handoffs root that holds a launch's folder.
 * Why: one machine dispatcher serves many repos and only sees folders through launch tickets.
 *
 * @param {string} directory - A launch's handoff folder.
 */
export function rememberHandoffRoot(directory) {
  const root = dirname(directory);
  if (handoffRoots().includes(root)) return;
  try {
    mkdirSync(dirname(rootsFile()), { recursive: true, mode: 0o700 });
    appendFileSync(rootsFile(), root + '\n', { mode: 0o600 });
  } catch { /* a root that cannot be remembered is swept only while its launches run */ }
}

/** Every remembered submit-handoffs root. */
export function handoffRoots() {
  try { return readFileSync(rootsFile(), 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
}

/**
 * When the folder's gate ended (its result was written), or null while it may still be queued or running. A gate
 * whose driver still runs is spared by the caller's protect set, which names every running and queued job [C7].
 */
function endedAt(directory) {
  let ended = null;
  for (const name of ['submission.json', 'refusal.json']) {
    try { ended = Math.max(ended ?? 0, statSync(join(directory, name)).mtimeMs); } catch { /* no such result */ }
  }
  return ended;
}

/**
 * Whether this folder holds the red gate log of an item that has neither landed nor been withdrawn.
 * Why: on 6 Nov at least 8 main-red items were released BLOCKED because the failing assertion had been pruned away [C7,#3381].
 * A board that exists but cannot be read keeps the log; a folder with no request, red result or board never does.
 *
 * @param {string} root - The submit-handoffs root, whose parent holds board.sqlite.
 * @param {string} directory - One handoff folder.
 * @returns {boolean} True when the folder's logs must stay.
 */
export function redLogKept(root, directory) {
  let item;
  try {
    statSync(join(directory, 'refusal.json'));
    item = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')).item;
  } catch { return false; }
  if (!Number.isSafeInteger(item)) return false;
  const file = join(dirname(root), 'board.sqlite');
  try { statSync(file); } catch { return false; }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const row = db.prepare('SELECT item_status, item_merged_commit FROM item WHERE item_id = ?').get(item);
    return Boolean(row) && !row.item_merged_commit && row.item_status !== 'withdrawn';
  } catch { return true; }
  finally { try { db?.close(); } catch { /* already closed */ } }
}

/**
 * Remove handoff folders whose gate ended more than the keep time ago. A folder with no result, a live worker, or a
 * job in `protect` (queued or running) is never removed, and neither is a red gate's folder while its item is open. Why: 3,477 folders (2.4 GB) kept fseventsd at 2 cores on 6 Nov.
 *
 * @param {string[]} roots - submit-handoffs roots to sweep.
 * @param {{ now?: number, keepMs?: number, protect?: Set<string>, limit?: number }} [options] - Clock, keep time, jobs to spare, batch size.
 * @returns {string[]} Removed folder paths.
 */
export function pruneFinishedHandoffs(roots, { now = Date.now(), keepMs = HANDOFF_FOLDER_KEEP_MS, protect = new Set(), limit = HANDOFF_PRUNE_BATCH } = {}) {
  const removed = [];
  for (const root of new Set(roots)) {
    let names;
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (removed.length >= limit) return removed;
      if (protect.has(name)) continue;
      const directory = join(root, name);
      const ended = endedAt(directory);
      if (ended === null || now - ended < keepMs || redLogKept(root, directory)) continue;
      try { rmSync(directory, { recursive: true, force: true }); removed.push(directory); } catch { /* retried on the next pass */ }
    }
  }
  return removed;
}
