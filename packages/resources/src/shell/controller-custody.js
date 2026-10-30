/** Read-only health custody for actual controller/holder incarnations, never resource availability authority [C7]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Retain only this controller's declared deadline or unresolved lifecycle observation. */
export function createControllerCustody(owner, parentPid, { processStarted, machineHome }) {
  let file, started, deadline, problem;
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
    if (!deadline && !problem) { close(); return; }
    started ??= processStarted(process.pid);
    if (!started) throw new Error('controller custody needs the exact process start');
    const directory = join(machineHome(), 'controller-deadlines');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify({ version: 1, token: owner.token, pool: owner.pool, holderPid: parentPid,
      controllerPid: process.pid, started, ...(deadline ? { deadline } : {}), ...(problem ? { problem } : {}) });
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

/** Join diagnostics to exact current holders; this reader never clears, releases or recovers capacity. */
export function controllerLeaseHealth(now, { processStarted, machineHome }) {
  const directory = join(machineHome(), 'controller-deadlines');
  if (!existsSync(directory)) return [];
  const expectedPool = join(machineHome(), 'resources.sqlite');
  if (!existsSync(expectedPool)) return [];
  const pool = realpathSync(expectedPool), db = new DatabaseSync(pool, { readOnly: true });
  try {
    const rows = [];
    for (const name of readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name))) {
      let record;
      try {
        const file = join(directory, name), state = lstatSync(file);
        if (!state.isFile() || state.size > 4096) continue;
        record = JSON.parse(readFileSync(file, 'utf8'));
      } catch { continue; /* Partial or damaged diagnostics cannot identify a holder. */ }
      if (record.version !== 1 || record.pool !== pool || !Number.isSafeInteger(record.holderPid)
        || !Number.isSafeInteger(record.controllerPid) || !record.started) continue;
      const overdue = Number.isSafeInteger(record.deadline) && record.deadline <= now;
      const problem = typeof record.problem === 'string' && record.problem.length <= 512 ? record.problem : undefined;
      if (!overdue && !problem) continue;
      const holder = db.prepare('SELECT pid,started,agent,repo,item,kind,runner FROM holder WHERE token=?').get(record.token);
      if (!holder || holder.pid !== record.holderPid || !holder.started || processStarted(holder.pid) !== holder.started) continue;
      if (processStarted(record.controllerPid) !== record.started) continue;
      rows.push({ ...holder, controllerPid: record.controllerPid, ...(overdue ? { deadline: record.deadline } : {}),
        ...(problem ? { problem } : {}) });
    }
    return rows;
  } finally { db.close(); }
}
