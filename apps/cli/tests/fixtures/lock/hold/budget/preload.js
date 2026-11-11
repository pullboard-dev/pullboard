/** Observe only the original private CLI's actual board transactions, never SQL arguments [B2,C7]. */
import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';

const entry = process.env.PULLBOARD_LOCK_BUDGET_ENTRY;
const owner = process.env.PULLBOARD_LOCK_BUDGET_OWNER_PID;
if (isMainThread && entry && process.argv[1] && resolve(process.argv[1]) === resolve(entry)
  && (!owner || owner === String(process.pid))) {
  process.env.PULLBOARD_LOCK_BUDGET_OWNER_PID = String(process.pid);
  const target = process.env.PULLBOARD_LOCK_BUDGET_TRACE;
  const label = process.env.PULLBOARD_LOCK_BUDGET_COMMAND;
  const active = new Map();
  let sequence = 0;
  /** Fail visibly if the observer cannot retain its evidence; never turn a missing sample into a pass. */
  function emit(row) {
    try { appendFileSync(target, JSON.stringify({ pid: process.pid, command: label, ...row }) + '\n'); }
    catch { process.stderr.write('LOCK_BUDGET_OBSERVER_UNAVAILABLE\n'); }
  }
  emit({ kind: 'runtime', at: Date.now(), node: process.version, platform: process.platform, arch: process.arch });
  const exec = DatabaseSync.prototype.exec;
  /** Preserve native authority, arguments, receiver, result and errors; observe only actual board BEGINs. */
  function observedExec(sql, ...args) {
    const begin = typeof sql === 'string' && /^\s*BEGIN(?:\s+(IMMEDIATE|DEFERRED|EXCLUSIVE))?\s*;?\s*$/iu.exec(sql);
    const release = typeof sql === 'string' && /^\s*(COMMIT|ROLLBACK)\s*;?\s*$/iu.exec(sql);
    const site = begin ? new Error().stack.split('\n').slice(1, 9) : [];
    const board = site.some(line => line.includes('/packages/store/src/io/board/busy.js:'));
    const waitingAt = performance.now();
    const result = Reflect.apply(exec, this, [sql, ...args]);
    const ended = performance.now();
    if (begin) {
      const record = { board, site, transactionMode: begin[1]?.toLowerCase() ?? 'deferred-default',
        writeLockEvidence: /^(?:IMMEDIATE|EXCLUSIVE)$/iu.test(begin[1] ?? ''), id: ++sequence, acquiredAt: Date.now(), started: ended, waitMs: ended - waitingAt };
      active.set(this, record);
      emit({ kind: 'begin', ...record, started: undefined });
    }
    if (release && active.has(this)) {
      const record = active.get(this);
      active.delete(this);
      emit({ kind: 'hold', ...record, started: undefined, releasedAt: Date.now(), heldMs: ended - record.started, outcome: release[1].toLowerCase() });
    }
    return result;
  }
  Object.defineProperties(observedExec, Object.getOwnPropertyDescriptors(exec));
  DatabaseSync.prototype.exec = observedExec;
  const close = DatabaseSync.prototype.close;
  /** A native close without explicit release is incomplete evidence, never a successful timing sample. */
  function observedClose(...args) {
    const result = Reflect.apply(close, this, args);
    if (active.has(this)) { emit({ kind: 'incomplete', ...active.get(this), started: undefined }); active.delete(this); }
    return result;
  }
  Object.defineProperties(observedClose, Object.getOwnPropertyDescriptors(close));
  DatabaseSync.prototype.close = observedClose;
  process.on('exit', code => {
    for (const record of active.values()) emit({ kind: 'incomplete', ...record, started: undefined });
    emit({ kind: 'exit', code, at: Date.now() });
  });
}
