/**
 * The cross-process board write queue [C7,#8163]: a file form of the write-queue port, so a caller that crashes after
 * submitting still finds its write's result. Why: the in-process queue keeps writes in one promise chain, and a
 * crashed caller loses both its write and its answer. Nothing calls this yet and no setting is read here.
 *
 * With `transaction` and `savepoint` ports (each runs a function and returns its result, as `atomic(board, work)` does),
 * the one writer drains every write it finds queued for its own process, in queue order, inside ONE short transaction
 * (group commit), each write inside its own savepoint so a refused write rolls back only itself. Grouped writes must be
 * synchronous: a transaction cannot stay open across an await. Without the ports each write runs alone, as before.
 *
 * Layout in `dir`: `<id>.pending` (the write waits), `<id>.result` ({ ok, value } or { ok: false, error }), and
 * `drain.lock` (the process now draining). Records are written to a temp name and renamed, so a reader never sees half.
 */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.js';

const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 5;

/** Read a JSON record, or null when it is missing or unreadable. */
function readRecord(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** True when the lock's owning process is gone, or the lock never got an owner record and is a few seconds old. */
function lockIsStale(lock) {
  let held;
  try { held = readdirSync(lock).map(name => Number.parseInt(name, 10)).find(Number.isInteger); } catch { return false; /* the holder released it between our look and our read */ }
  if (held !== undefined) {
    try { process.kill(held, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }
  try { return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { return false; }
}

/** Take the drain lock without blocking; true when this process now holds it. */
function takeLock(lock) {
  try { mkdirSync(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
  writeFileSync(join(lock, `${process.pid}.holder`), '');
  return true;
}

/** Wait a few ms without blocking the event loop. */
const pause = ms => new Promise(done => setTimeout(done, ms));

/**
 * @param {string} dir the queue directory shared by every process; each write's `run` receives its queue sequence number
 * @param {{ transaction?: <T>(work: () => T) => T, savepoint?: <T>(work: () => T) => T }} [ports]
 * @returns {{ submit: (write: { id: string, run: () => unknown }) => Promise<{ ok: boolean, value?: unknown, error?: { code: string, message: string } }>,
 *   result: (id: string) => { ok: boolean, value?: unknown, error?: { code: string, message: string } } | null }}
 */
export function createFileWriteQueue(dir, { transaction, savepoint } = {}) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'drain.lock');
  const resultFile = id => join(dir, `${id}.result`);
  const pendingFile = id => join(dir, `${id}.pending`);
  const runs = new Map();
  let counter = 0;

  /** True when `pid` is a live process. */
  function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  }

  /** Every pending write still worth running, oldest first; drops records already answered or whose owner died (its function is gone). */
  function pendingWrites() {
    const entries = readdirSync(dir).filter(name => name.endsWith('.pending')).map(name => {
      const record = readRecord(join(dir, name));
      return { id: name.slice(0, -'.pending'.length), seq: record?.seq ?? 0, pid: record?.pid };
    }).sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
    return entries.filter(entry => {
      if (existsSync(resultFile(entry.id)) || (!runs.has(entry.id) && Number.isInteger(entry.pid) && !alive(entry.pid))) {
        rmSync(pendingFile(entry.id), { force: true });
        return false;
      }
      return true;
    });
  }

  /** Store a write's outcome and clear its pending record. */
  function settle(id, outcome) {
    writeFileAtomic(resultFile(id), JSON.stringify(outcome));
    rmSync(pendingFile(id), { force: true });
  }

  /** The outcome of a thrown error, as stored beside the write. */
  const failure = error => ({ ok: false, error: { code: String(error?.code ?? 'WRITE_FAILED'), message: String(error?.message ?? error) } });

  /** Run, in one transaction, every leading write this process owns; a refused write rolls back only itself. Results are stored after the commit. */
  function commitGroup(batch) {
    const outcomes = [];
    try {
      transaction(() => {
        for (const { id, seq } of batch) {
          try { outcomes.push({ id, outcome: { ok: true, value: (savepoint ? savepoint(() => runs.get(id)(seq)) : runs.get(id)(seq)) ?? null } }); }
          catch (error) { outcomes.push({ id, outcome: failure(error) }); }
        }
      });
    } catch (error) {
      for (const { id } of batch) settle(id, failure(error));
      return;
    }
    for (const { id, outcome } of outcomes) settle(id, outcome);
  }

  /** Run this process's pending writes oldest first; stops at the oldest write another live process owns, so it runs it next. */
  async function drain() {
    for (let list = pendingWrites(); list.length && runs.has(list[0].id); list = pendingWrites()) {
      if (transaction) {
        const batch = [];
        for (const entry of list) { if (!runs.has(entry.id)) break; batch.push(entry); }
        commitGroup(batch);
        continue;
      }
      const next = list[0];
      let outcome;
      try { outcome = { ok: true, value: await runs.get(next.id)(next.seq) ?? null }; }
      catch (error) { outcome = failure(error); }
      settle(next.id, outcome);
    }
  }

  return {
    /** Queue a write; resolves with its stored outcome. A repeat of an id that has a result returns it unrun. */
    async submit({ id, run }) {
      const done = readRecord(resultFile(id));
      if (done) return done;
      if (!existsSync(pendingFile(id))) writeFileAtomic(pendingFile(id), JSON.stringify({ seq: Date.now() * 1000 + (counter++ % 1000), pid: process.pid }));
      runs.set(id, run);
      if (transaction) await new Promise(done => queueMicrotask(done)); // let every write submitted in this turn queue before the drain
      for (let stored = readRecord(resultFile(id)); !stored; stored = readRecord(resultFile(id))) {
        if (takeLock(lock)) {
          try { await drain(); } finally { rmSync(lock, { recursive: true, force: true }); }
          if (!readRecord(resultFile(id))) await pause(LOCK_RETRY_MS);
        } else {
          if (lockIsStale(lock)) rmSync(lock, { recursive: true, force: true });
          await pause(LOCK_RETRY_MS);
        }
      }
      runs.delete(id);
      return readRecord(resultFile(id));
    },
    /** The stored outcome of write `id`, or null when it has not finished. */
    result: id => readRecord(resultFile(id)),
    /** Drop write `id`'s stored outcome, so the next submit of that id runs afresh. */
    forget: id => rmSync(resultFile(id), { force: true }),
    /** Remove every stored outcome and mark older than `maxAgeMs`; a pending write is never touched. Returns how many files went. */
    prune(maxAgeMs, now = Date.now()) {
      let removed = 0;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.result') && !name.endsWith('.mark')) continue;
        try {
          if (now - statSync(join(dir, name)).mtimeMs <= maxAgeMs) continue;
          rmSync(join(dir, name), { force: true });
          removed += 1;
        } catch { /* another process pruned it first */ }
      }
      return removed;
    },
  };
}
