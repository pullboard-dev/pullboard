import { spawnSync } from 'node:child_process';
import { cleanGitEnvironment } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
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
export function createControllerCustody(owner, parentPid, { processStarted, machineHome, registerController, releaseController }, sourceRoot) {
  let file, started, deadline, problem;
  let registered;
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
    if (registered) {
      releaseController(owner, parentPid, registered);
      registered = undefined;
    }
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
    if (!registered) {
      registered = { version: 1, holderStarted, controllerPid: process.pid, started, ...(source ? { source } : {}) };
      registerController(owner, parentPid, registered);
    }
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
        || !Number.isSafeInteger(record.controllerPid) || record.controllerPid < 1
        || typeof record.started !== 'string' || !record.started.trim()) continue;
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

/** Read only native registrations; diagnostic files never grant permission to release a holder. */
function registeredControllers(db) {
  if (!db.prepare('PRAGMA table_info(holder)').all().some(row => row.name === 'controller_identity')) return [];
  return db.prepare("SELECT token,pid,started,agent,repo,item,kind,runner,controller_identity FROM holder WHERE controller_identity <> ''").all().flatMap(holder => {
    try {
      const record = JSON.parse(holder.controller_identity);
      if (record.version !== 1 || !Number.isSafeInteger(record.controllerPid) || record.controllerPid < 1
        || typeof record.started !== 'string' || !record.started.trim()
        || record.holderStarted !== holder.started) return [];
      return [{ holder, record }];
    } catch { return []; /* A damaged native identity is unknown custody, never proof of death. */ }
  });
}

/** Find proven orphan incarnations for the queue's own transaction; return no guessed remote cleanup proof. */
export function orphanedControllerLeases(db, { sameProcess }) {
  return registeredControllers(db).flatMap(({ holder, record }) => {
    if (!holder.runner) return [];
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
    const rows = orphanedControllerLeases(db, { sameProcess }).map(({ token: _token, controller_identity: _identity, cause, ...holder }) => ({ ...holder, problem: cause }));
    const orphanPids = new Set(rows.map(row => row.controllerPid));
    for (const record of custodyRecords(pool, machineHome)) {
      const holder = db.prepare('SELECT pid,started,agent,repo,item,kind,runner FROM holder WHERE token=?').get(record.token);
      if (!holder || holder.pid !== record.holderPid || !holder.started) continue;
      const overdue = Number.isSafeInteger(record.deadline) && record.deadline <= now;
      if (orphanPids.has(record.controllerPid)) continue;
      const problem = typeof record.problem === 'string' && record.problem.length <= 512 ? record.problem : undefined;
      if (!overdue && !problem) continue;
      if (processStarted(holder.pid) !== holder.started || processStarted(record.controllerPid) !== record.started) continue;
      rows.push({ ...holder, controllerPid: record.controllerPid, ...(overdue ? { deadline: record.deadline } : {}),
        ...(problem ? { problem } : {}) });
    }
    return rows;
  } finally { db.close(); }
}

/** Release only an exact proven orphan, with its cleanup audit and unknown-remote quarantine in the same queue commit. */
export function pruneControllerOrphans(db, { sameProcess, recordRunnerFailure }) {
  const rows = orphanedControllerLeases(db, { sameProcess });
  for (const row of rows) {
    const diagnostic = { reason: 'controller-orphan', phase: 'cleanup', cause: row.cause,
      holderPid: row.pid, controllerPid: row.controllerPid, item: row.item, source: row.repo,
      remoteCleanup: 'unknown' };
    recordRunnerFailure(db, row.runner, 'cleanup-unverified', diagnostic);
    db.prepare('INSERT INTO runner_recovery_event VALUES(?,?,?,?,?)').run(randomUUID(), row.runner,
      new Date().toISOString(), 'cleanup', JSON.stringify(diagnostic));
    db.prepare('DELETE FROM holder WHERE token=? AND pid=? AND started=?').run(row.token, row.pid, row.started);
  }
}

/** Bind native custody using the queue's canonical opener and transaction, never a diagnostic-file assertion. */
export function controllerRegistrationPorts({ pool, open, update, processStarted }) {
  return {
    /** Register this actual controller under its parent's unbound native lease. */
    registerController(owner, parentPid, identity) {
      if (owner.pool !== pool() || identity.controllerPid !== process.pid
        || identity.started !== processStarted(process.pid)
        || parentPid !== process.pid && parentPid !== process.ppid) throw new Refused('RESOURCE_LEASE_LOST', 'runner controller does not own this lease incarnation');
      const db = open(pool(), true);
      try {
        update(db, () => {
          const holder = db.prepare('SELECT pid,started,controller_identity FROM holder WHERE token=?').get(owner.token);
          if (!holder || holder.pid !== parentPid || holder.started !== identity.holderStarted || holder.controller_identity)
            throw new Refused('RESOURCE_LEASE_LOST', "runner controller needs its actual parent's unbound native lease");
          db.prepare('UPDATE holder SET controller_identity=? WHERE token=?').run(JSON.stringify(identity), owner.token);
        });
      } finally { db.close(); }
    },
    /** Clear only this registration, before a normal controller exit can look like an orphan. */
    releaseController(owner, parentPid, identity) {
      const db = open(pool(), true);
      try {
        update(db, () => db.prepare("UPDATE holder SET controller_identity='' WHERE token=? AND pid=? AND controller_identity=?")
          .run(owner.token, parentPid, JSON.stringify(identity)));
      } finally { db.close(); }
    },
  };
}

/** Resolve the actual board of this checkout or its private clone origin, never a request-selected database. */
export function runnerBoardFile(root, hops = 3) {
  let info;
  try { info = repoInfo(root); } catch { return null; }
  const file = join(info.commonDir, 'pullboard', 'board.sqlite');
  if (existsSync(file)) return file;
  if (hops <= 0) return null;
  const origin = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
  const url = origin.status === 0 ? origin.stdout.trim() : '';
  return url && isAbsolute(url) && existsSync(url) ? runnerBoardFile(url, hops - 1) : null;
}

/** Observe only board identity and item terminal state for resource lifecycle; no native or write authority. */
export function runnerItemState(root, item) {
  if (!/^[1-9][0-9]*$/u.test(String(item ?? ''))) return null;
  const id = Number(item);
  if (!Number.isSafeInteger(id)) return null;
  const file = runnerBoardFile(root);
  if (!file) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT meta.meta_value AS board, item.item_id, item.item_status, item.item_merged_commit FROM item JOIN board_meta meta ON meta.meta_key='board_id' WHERE item.item_id=? AND NOT EXISTS(SELECT 1 FROM board_meta redirect WHERE redirect.meta_key='item_redirect:' || item.item_id)").get(id);
    if (!row) return null;
    if (!['open', 'claimed', 'submitted', 'verified', 'withdrawn'].includes(row.item_status)) throw new Error('unknown item lifecycle status');
    return { board: row.board, item: row.item_id,
      terminal: Boolean(row.item_merged_commit || row.item_status === 'withdrawn') };
  } finally { db.close(); }
}
