/** Observe actual production list work without replacing any database result or CLI behavior [C7,#12932]. */
import { DatabaseSync } from 'node:sqlite';
import { Session } from 'node:inspector';

/** Send one V8 coverage request and retain its native error. */
function request(session, method, params = {}) {
  return new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
}

/** Count a named function's actual invocations in one precise coverage observation. */
function calls(coverage, file, name) {
  return coverage.result.filter(script => script.url.endsWith(file))
    .flatMap(script => script.functions).filter(fn => fn.functionName === name)
    .reduce((total, fn) => total + fn.ranges[0].count, 0);
}

/** Count merge queries and uncached-or-cached display-name calls, preserving the required rescope agent reads. */
export async function recordListReads(work) {
  const reads = { merges: 0, agents: 0 };
  const prepare = DatabaseSync.prototype.prepare;
  const session = new Session();
  session.connect();
  await request(session, 'Profiler.enable');
  await request(session, 'Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  DatabaseSync.prototype.prepare = function recorded(sql, ...args) {
    if (sql.includes("event_kind IN ('reopen', 'accept', 'reject', 'merge-only-accept')")) reads.merges++;
    return prepare.call(this, sql, ...args);
  };
  try {
    const result = await work();
    const coverage = await request(session, 'Profiler.takePreciseCoverage');
    // Each rescope pair needs listAgents too. The text renderer's extra call returns cached rows and starts no SQL query.
    reads.agents = calls(coverage, '/packages/store/src/io/board/query.js', 'listAgents')
      - calls(coverage, '/packages/store/src/io/cooldown.js', 'itemsNeedingRescope');
    return { result, reads };
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    await request(session, 'Profiler.stopPreciseCoverage');
    session.disconnect();
  }
}
