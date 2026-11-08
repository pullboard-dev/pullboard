/** Resource queue admission covers every writer, including initialization [C7]. */
import { Refused } from '../../../kernel/index.js';

/** Translate contention from any transaction phase without replacing unrelated SQLite or application errors. */
export function resourceWriteError(error, file) {
  if (!((Number.isInteger(error?.errcode) && [5, 6].includes(error.errcode & 0xff))
    || ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error?.code) || /database is locked/iu.test(error?.message ?? ''))) return error;
  const stopped = new Refused('SLOT_DB_LOCKED', `never ran: the resource queue ${file ?? 'database'} stayed locked; retry when the writer finishes`);
  stopped.neverRanExitCode = 75;
  return stopped;
}

/** A write that stayed queued past its deadline: typed so a caller sees SLOT_DB_LOCKED and the exit code of a run that never ran [C7,#3084]. */
export function resourceQueueStalled(message) {
  const stopped = new Refused('SLOT_DB_LOCKED', message);
  stopped.neverRanExitCode = 75;
  return stopped;
}

/** Admit every resource writer, including dispatcher startup, with a bounded retry and typed exhaustion. */
export function beginResourceWrite(db, { file, timeoutMs: timeout = 10_000 } = {}) {
  const started = Date.now();
  const original = db.prepare('PRAGMA busy_timeout').get().timeout;
  try {
    for (;;) {
      const remaining = Math.max(1, timeout - (Date.now() - started));
      db.exec(`PRAGMA busy_timeout = ${Math.min(100, remaining)}`);
      try { db.exec('BEGIN IMMEDIATE'); return; }
      catch (error) {
        if (!((Number.isInteger(error?.errcode) && [5, 6].includes(error.errcode & 0xff)) || ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error?.code) || /database is locked/iu.test(error?.message ?? ''))) throw error;
        if (Date.now() - started >= timeout) {
          const stopped = new Refused('SLOT_DB_LOCKED', `never ran: the resource queue ${file ?? 'database'} stayed locked for ${Date.now() - started}ms; retry when the writer finishes`);
          stopped.neverRanExitCode = 75;
          throw stopped;
        }
        if ((error.errcode & 0xff) === 6) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, remaining));
      }
    }
  } finally { db.exec(`PRAGMA busy_timeout = ${original}`); }
}

