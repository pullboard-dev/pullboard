/** Diagnostic-only SQL read costs and sampled frames for one complete real JSON list [C7,#12932]. */
import { Session } from 'node:inspector';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

/** Await the inspector's actual response without replacing a production read. */
function request(session, method, params = {}) {
  return new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
}

/** Record prepare/get/all CPU and wall costs, preserving native arguments, results and errors. */
export async function startListReadProfile(destination) {
  const reads = new Map();
  const prepare = DatabaseSync.prototype.prepare;
  const session = new Session();
  session.connect();
  await request(session, 'Profiler.enable');
  await request(session, 'Profiler.setSamplingInterval', { interval: 100 });
  await request(session, 'Profiler.start');
  /** Measure one real SQLite operation, including an operation that throws. */
  const measured = (sql, operation, work) => {
    const key = `${operation} ${sql.replace(/\s+/gu, ' ').trim()}`;
    const row = reads.get(key) ?? { operation, sql: sql.replace(/\s+/gu, ' ').trim(), calls: 0, cpuMs: 0, wallMs: 0 };
    reads.set(key, row);
    const cpu = process.cpuUsage();
    const wall = performance.now();
    try { return work(); }
    finally {
      const elapsed = process.cpuUsage(cpu);
      row.calls++;
      row.cpuMs += (elapsed.user + elapsed.system) / 1000;
      row.wallMs += performance.now() - wall;
    }
  };
  DatabaseSync.prototype.prepare = function recorded(sql, ...args) {
    if (!/^\s*(?:SELECT|WITH|PRAGMA)\b/iu.test(sql)) return prepare.call(this, sql, ...args);
    const statement = measured(sql, 'prepare', () => prepare.call(this, sql, ...args));
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!['get', 'all'].includes(key)) return value.bind(target);
      return (...values) => measured(sql, key, () => value.apply(target, values));
    } });
  };
  return async () => {
    DatabaseSync.prototype.prepare = prepare;
    const { profile } = await request(session, 'Profiler.stop');
    session.disconnect();
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    const frames = new Map();
    for (const [index, id] of profile.samples.entries()) {
      const frame = nodes.get(id).callFrame;
      const name = `${frame.url || '(native)'}:${frame.functionName}:${frame.lineNumber + 1}`;
      frames.set(name, (frames.get(name) ?? 0) + profile.timeDeltas[index] / 1000);
    }
    writeFileSync(destination, JSON.stringify({
      note: 'Diagnostic instrumentation only; sampled frame residency is not per-function CPU. SQL prepare/get/all use actual process CPU deltas; iterator consumption is not timed.',
      reads: [...reads.values()].sort((a, b) => b.cpuMs - a.cpuMs),
      frames: [...frames].sort((a, b) => b[1] - a[1]).slice(0, 45),
    }));
  };
}
