/** Exact controller/holder custody; native queue cleanup alone changes resource availability [C7]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Retain only this controller's declared deadline or unresolved lifecycle observation. */
export function createControllerCustody(owner, parentPid, { processStarted, machineHome }, sourceRoot) {
  let file, started, deadline, problem;
  const holderStarted = processStarted(parentPid);
  let source;
  if (typeof sourceRoot === 'string' && isAbsolute(sourceRoot)) {
    try {
      const state = statSync(sourceRoot);
      source = { root: sourceRoot, dev: state.dev, ino: state.ino };
    } catch { /* The controller's ordinary source observer retains its original cancellation/refusal order. */ }
  }
  /** Remove only the exact diagnostic created by this controller. */
  const close = () => {
    if (!file) return;
    try { unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    file = undefined;
  };
  /** Publish a complete diagnostic atomically; neither a damaged file nor an unrelated lease attests health. */
  const publish = () => {
    if (!owner || typeof owner.token !== 'string' || typeof owner.pool !== 'string') return;
    started ??= processStarted(process.pid);
    if (!started) throw new Error('controller custody needs the exact process start');
    const directory = join(machineHome(), 'controller-deadlines');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify({ version: 1, token: owner.token, pool: owner.pool, holderPid: parentPid, holderStarted,
      controllerPid: process.pid, started, ...(source ? { source } : {}),
      ...(deadline ? { deadline } : {}), ...(problem ? { problem } : {}) });
    if (!file) {
      const candidate = join(directory, `${randomUUID()}.json`);
      writeFileSync(candidate, bytes, { flag: 'wx', mode: 0o600 });
      file = candidate;
      return;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try { renameSync(temporary, file); }
    finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  };
  // Unbounded, healthy work still needs custody if this controller exits without its normal finally.
  publish();
  return {
    ready(timeoutMs) {
      if (deadline || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return;
      deadline = Date.now() + timeoutMs;
      publish();
    },
    observationProblem(value) {
      const next = typeof value === 'string' && value ? value.slice(0, 512) : undefined;
      if (next === problem) return;
      problem = next;
      publish();
    },
    close,
  };
}

/** Read complete records only; damaged or foreign files never identify a native holder. */
function custodyRecords(pool, machineHome) {
  const directory = join(machineHome(), 'controller-deadlines');
  if (!existsSync(directory)) return [];
  const records = [];
  for (const name of readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name))) {
    try {
      const file = join(directory, name), state = lstatSync(file);
      if (!state.isFile() || state.size > 4096) continue;
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (record.version !== 1 || record.pool !== pool || typeof record.token !== 'string'
        || !Number.isSafeInteger(record.holderPid) || record.holderPid < 1
        || !Number.isSafeInteger(record.controllerPid) || record.controllerPid < 1 || !record.started) continue;
      records.push(record);
    } catch { /* A partial, missing or unreadable record cannot authorize cleanup. */ }
  }
  return records;
}

/** A matching caller incarnation and source identity distinguish an orphan from unknown observation. */
function orphanReason(record, holder, sameProcess) {
  if (!record.holderStarted || record.holderStarted !== holder.started) return null;
  if (!sameProcess(holder.pid, holder.started)) return 'holder process is gone';
  if (!sameProcess(record.controllerPid, record.started)) return 'controller process is gone';
  const source = record.source;
  if (!source || source.root !== holder.repo || !isAbsolute(source.root)
    || !Number.isSafeInteger(source.dev) || !Number.isSafeInteger(source.ino)) return null;
  try {
    const state = statSync(source.root);
    if (!state.isDirectory() || state.dev !== source.dev || state.ino !== source.ino) return 'source directory identity changed';
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'source directory is gone';
    // Permission and observation failures retain custody; absence must be positively established.
  }
  return null;
}

/** Find proven orphan incarnations for the queue's own transaction; return no guessed remote cleanup proof. */
export function orphanedControllerLeases(db, pool, { machineHome, sameProcess }) {
  return custodyRecords(pool, machineHome).flatMap(record => {
    const holder = db.prepare('SELECT token,pid,started,agent,repo,item,kind,runner FROM holder WHERE token=?').get(record.token);
    if (!holder || holder.pid !== record.holderPid || !holder.runner) return [];
    const cause = orphanReason(record, holder, sameProcess);
    return cause ? [{ ...holder, controllerPid: record.controllerPid, cause }] : [];
  });
}

/** Join diagnostics to exact holders, including dead controllers; this health reader never releases capacity. */
export function controllerLeaseHealth(now, { processStarted, machineHome, sameProcess }) {
  const expectedPool = join(machineHome(), 'resources.sqlite');
  if (!existsSync(expectedPool)) return [];
  const pool = realpathSync(expectedPool), db = new DatabaseSync(pool, { readOnly: true });
  try {
    const rows = [];
    for (const record of custodyRecords(pool, machineHome)) {
      const holder = db.prepare('SELECT pid,started,agent,repo,item,kind,runner FROM holder WHERE token=?').get(record.token);
      if (!holder || holder.pid !== record.holderPid || !holder.started) continue;
      const overdue = Number.isSafeInteger(record.deadline) && record.deadline <= now;
      const orphan = orphanReason(record, holder, sameProcess);
      const problem = orphan ?? (typeof record.problem === 'string' && record.problem.length <= 512 ? record.problem : undefined);
      if (!overdue && !problem) continue;
      if (!orphan && (processStarted(holder.pid) !== holder.started || processStarted(record.controllerPid) !== record.started)) continue;
      rows.push({ ...holder, controllerPid: record.controllerPid, ...(overdue ? { deadline: record.deadline } : {}),
        ...(problem ? { problem } : {}) });
    }
    return rows;
  } finally { db.close(); }
}
