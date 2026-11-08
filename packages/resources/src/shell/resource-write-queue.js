/**
 * One ordered writer for a resource database [C7,#3084]. Every write appends an entry to a queue folder beside the
 * database; whichever caller finds the writer free applies the queued entries in order, each in its own short
 * transaction. Why: with dozens of handoff workers each opening BEGIN IMMEDIATE, the SQLite file lock stayed held for
 * seconds and a worker-exit release died on SLOT_DB_LOCKED. No daemon runs: a waiting caller drains, a release
 * appends and leaves, and the next writer applies it.
 */
import { closeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { resourceQueueStalled } from './resource-write-lock.js';

/** A live writer that holds the queue longer than this has hung; the next caller takes the writer over. */
const WRITER_STALE_MS = 30_000;
/** How long a waiting caller sleeps between looks at the queue. */
const POLL_MS = 0.25;
const pauseCell = new Int32Array(new SharedArrayBuffer(4));
/** Queue files whose writer this thread holds, so a nested write runs inside the outer turn. */
const held = new Set();
/** Queue folders this process has already created. */
const made = new Set();
let sequence = 0;

/** Name the queue folder that serializes writes to one database file. */
export function resourceQueueDirectory(file) {
  return `${file}.writes`;
}

/** Make a queue entry name that sorts by arrival across processes: the monotonic clock is shared machine-wide. */
function entryName(kind) {
  const at = process.hrtime.bigint().toString().padStart(24, '0');
  return `${at}-${String(sequence++).padStart(6, '0')}-${kind}-${process.pid}-${threadId}-${randomUUID().slice(0, 8)}`;
}

/** Read the queue in arrival order, skipping files still being written. */
function entries(dir) {
  try { return readdirSync(dir).filter(name => /^\d{24}-/u.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/** Check whether the process that queued an entry or holds the writer is still running. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Parse the owning pid out of an entry name. */
function entryPid(name) {
  return Number(name.split('-')[3]);
}

/** Pause this thread briefly; resource writes are synchronous by contract. */
function pause(ms) {
  Atomics.wait(pauseCell, 0, 0, ms);
}

/** Try once to become the single writer, taking over a writer whose process died or hung. */
function tryLock(dir, owner) {
  const lock = join(dir, 'writer.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx');
      try { writeSync(fd, `${process.pid} ${Date.now()} ${owner}`); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let text = '';
    try { text = readFileSync(lock, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const [pid, at] = text.split(' ').map(Number);
    // A lock written but not yet filled reads empty; only a named dead or hung writer is replaced.
    if (!text || alive(pid) && Date.now() - at < WRITER_STALE_MS) return false;
    try { unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

/** Give up the writer this caller holds. */
function unlock(dir, owner) {
  const lock = join(dir, 'writer.lock');
  try { if (readFileSync(lock, 'utf8').endsWith(` ${owner}`)) unlinkSync(lock); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Remove one queue entry. */
function remove(dir, name) {
  try { unlinkSync(join(dir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/**
 * While holding the writer, apply queued entries in order until the head is a live turn of another caller.
 * Returns true when this caller's own turn reached the head. A queued write that fails on a held lock stays
 * queued for the next writer; any other failure drops it, since replaying a bad write cannot succeed.
 */
function drain(dir, apply, mine) {
  for (const name of entries(dir)) {
    if (name === mine) return true;
    if (name.includes('-t-')) {
      if (alive(entryPid(name))) return false;
      remove(dir, name);
      continue;
    }
    let entry;
    try { entry = JSON.parse(readFileSync(join(dir, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; remove(dir, name); continue; }
    try { apply(entry); }
    catch (error) { if (error?.code === 'SLOT_DB_LOCKED') return false; }
    remove(dir, name);
  }
  return mine === undefined;
}

/** After giving up the writer, apply anything queued meanwhile if no other writer has it, so no queued write is stranded. */
function settle(dir, apply) {
  for (;;) {
    const head = entries(dir)[0];
    if (!head || head.includes('-t-') && alive(entryPid(head))) return;
    const owner = randomUUID();
    if (!tryLock(dir, owner)) return;
    held.add(dir);
    try { drain(dir, apply); } finally { held.delete(dir); unlock(dir, owner); }
  }
}

/**
 * Wait for this caller's turn as the single writer of a resource database, applying earlier queued writes first.
 * The returned function ends the turn. Callers wait on the queue, never on the SQLite lock, and each wait is the
 * few milliseconds the writes ahead of them take.
 * @param {string|undefined} file - The database file; undefined runs unqueued, for a database the queue does not know.
 * @param {{ apply: (entry: object) => void, deadlineMs?: number }} options
 * @returns {() => void}
 */
export function enterResourceQueue(file, { apply, deadlineMs = 300_000 }) {
  if (!file) return () => {};
  const dir = resourceQueueDirectory(file);
  if (held.has(dir)) return () => {};
  makeDirectory(dir);
  const owner = randomUUID();
  // An empty queue with a free writer needs no turn entry: nobody is ahead to keep in order.
  if (!entries(dir).length && tryLock(dir, owner)) {
    held.add(dir);
    let ready = false;
    try { ready = drain(dir, apply); }
    finally { if (!ready) { held.delete(dir); unlock(dir, owner); } }
    if (ready) return leaver(dir, owner, apply, '');
  }
  const mine = entryName('t');
  closeSync(openSync(join(dir, mine), 'wx'));
  const started = Date.now();
  try {
    // Watch only the nearest live turn ahead, so a long line costs each waiter one stat per look, not a folder read.
    let ahead = '';
    for (;;) {
      if (!ahead || !existsSync(join(dir, ahead))) {
        const line = entries(dir);
        ahead = line.slice(0, Math.max(0, line.indexOf(mine))).findLast(name => name.includes('-t-') && alive(entryPid(name))) ?? '';
      }
      if (!ahead && tryLock(dir, owner)) {
        held.add(dir);
        let ready = false;
        try { ready = drain(dir, apply, mine); }
        finally { if (!ready) { held.delete(dir); unlock(dir, owner); } }
        if (ready) break;
      }
      if (Date.now() - started >= deadlineMs) {
        throw resourceQueueStalled(`never ran: the resource write queue ${dir} did not reach this write in ${Date.now() - started}ms; retry when the writer finishes`);
      }
      pause(POLL_MS);
    }
  } catch (error) {
    remove(dir, mine);
    throw error;
  }
  return leaver(dir, owner, apply, mine);
}

/** Make the function that ends a turn: apply what queued behind it, give up the writer, and hand on anything left. */
function leaver(dir, owner, apply, mine) {
  let left = false;
  return () => {
    if (left) return;
    left = true;
    if (mine) remove(dir, mine);
    try { drain(dir, apply); }
    finally { held.delete(dir); unlock(dir, owner); }
    settle(dir, apply);
  };
}

/** Create a queue folder once per process. */
function makeDirectory(dir) {
  if (made.has(dir)) return;
  mkdirSync(dir, { recursive: true });
  made.add(dir);
}

/**
 * Append a write that needs no answer, such as a lease release, and apply the queue now if the writer is free.
 * Why: a worker's exit release must never wait on, or fail for, another process's write.
 * @param {string} file
 * @param {object} entry - A plain, JSON-serializable write that every writer's apply understands.
 * @param {{ apply: (entry: object) => void }} options
 */
export function enqueueResourceWrite(file, entry, { apply }) {
  const dir = resourceQueueDirectory(file);
  makeDirectory(dir);
  const name = entryName('o');
  const draft = join(dir, `draft-${name}`);
  writeFileSync(draft, JSON.stringify(entry));
  renameSync(draft, join(dir, name));
  if (held.has(dir)) return;
  settle(dir, apply);
}
