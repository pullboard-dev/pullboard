/** A bounded diagnostic of real claim snapshots; it neither changes SQLite results nor retries a claim [B2,C7]. */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const trace = fileURLToPath(new URL('../.git/pullboard-claim-snapshot-trace.jsonl', import.meta.url));

/** Observe only the two snapshot reads in a private fixture's actual claim command. */
function observeClaim() {
  if (process.argv[2] !== 'claim') return;
  const originalPrepare = DatabaseSync.prototype.prepare;
  const connections = new WeakMap();
  let nextConnection = 0, observations = 0;
  /** Retain the original statement and return value; publish only counters and the last event's id/kind. */
  DatabaseSync.prototype.prepare = function prepare(sql, ...rest) {
    const statement = Reflect.apply(originalPrepare, this, [sql, ...rest]);
    const field = sql === 'PRAGMA data_version' ? 'data_version'
      : sql === 'SELECT total_changes() AS n' ? 'n' : null;
    if (!field) return statement;
    const db = this, originalGet = statement.get;
    /** Read the same original row before collecting diagnostic metadata. */
    statement.get = function get(...args) {
      const row = Reflect.apply(originalGet, this, args);
      if (observations++ >= 64) return row;
      if (!connections.has(db)) connections.set(db, { id: ++nextConnection });
      const previous = connections.get(db), value = row[field];
      let event = null;
      try { event = Reflect.apply(originalPrepare, db, ['SELECT event_id, event_kind FROM event ORDER BY event_id DESC LIMIT 1']).get(); }
      catch { /* A partially initialized private database still has useful counter observations. */ }
      const call = new Error().stack.split('\n').filter(line => /board-claim|board-write-preparation/u.test(line)).map(line => line.trim());
      appendFileSync(trace, JSON.stringify({ pid: process.pid, connection: previous.id, field,
        previous: previous[field] ?? null, value, event, call }) + '\n', { mode: 0o600 });
      previous[field] = value;
      return row;
    };
    return statement;
  };
}

if (process.env.PULLBOARD_CLAIM_SNAPSHOT_TRACE_CHILD === '1') observeClaim();
else {
  rmSync(trace, { force: true });
  const result = spawnSync(process.execPath, ['bin/run-tests.js',
    '--test-name-pattern=every refusal names a next step that works', 'test/refusal-next-steps.test.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
    env: { ...process.env, PULLBOARD_CLAIM_SNAPSHOT_TRACE_CHILD: '1',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${import.meta.url}`].filter(Boolean).join(' ') },
  });
  try { for (const line of readFileSync(trace, 'utf8').trim().split('\n')) process.stdout.write('# claim snapshot ' + line + '\n'); }
  catch (error) { process.stderr.write('claim snapshot diagnostic unavailable: ' + error.message + '\n'); }
  process.exitCode = result.status ?? 2;
}
