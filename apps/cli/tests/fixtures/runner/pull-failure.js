/** Read bounded, private-safe diagnostics after a real pull-fixture child fails [C7,#12952]. */
import { closeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const JOB = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const MARKS = ['start', 'prepare', 'prepared', 'connect', 'inventory', 'pack', 'source-sent', 'ready'];
const LIMIT = 16;

/** Read a bounded private file, optionally its tail; unavailable content never becomes a diagnostic payload. */
function boundedText(file, bytes = 65536, tail = false) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size > bytes && !tail) return '';
    const buffer = Buffer.alloc(Math.min(size, bytes));
    const read = readSync(fd, buffer, 0, buffer.length, tail ? Math.max(0, size - bytes) : 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch { return ''; /* A vanished job remains visible in the other phase records. */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** List only the fixture's native job identifiers, without publishing those private identifiers. */
function jobNames(directory, suffix = '') {
  try { return readdirSync(directory).filter(name => name.endsWith(suffix) && JOB.test(suffix ? name.slice(0, -suffix.length) : name)).sort(); }
  catch { return []; /* Missing queues are an ordinary pre-start or completed state. */ }
}

/** Read resource counts without taking a lease, changing capacity, pruning owners, or waiting on a writer. */
function poolCounts(file) {
  if (!existsSync(file)) return { state: 'absent' };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const counts = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return { state: 'read', holders: counts('holder'), waiters: counts('waiter') };
  } catch { return { state: 'unavailable' }; /* A locked or incomplete pool is evidence, never a reason to alter it. */ }
  finally { db?.close(); }
}

/** Snapshot actual durable phase records only after failure; raw specs, logs, paths and identifiers never leave this reader. */
export function pullFailureSnapshot({ home, machineHome, requests, startedAt }) {
  const identities = new Map();
  const identity = id => { if (!identities.has(id)) identities.set(id, `J${identities.size + 1}`); return identities.get(id); };
  const directory = join(machineHome, 'runner-jobs');
  const records = jobNames(directory, '.json');
  const controller = records.slice(0, LIMIT).map(name => {
    let row;
    try { row = JSON.parse(boundedText(join(directory, name), 1048576)); }
    catch { return { job: identity(name.slice(0, -5)), state: 'unavailable' }; }
    return { job: identity(name.slice(0, -5)), phase: MARKS.includes(row.phase) ? row.phase : 'other',
      marks: Object.fromEntries(MARKS.filter(mark => Number.isFinite(row.phaseAt?.[mark])).map(mark => [mark, row.phaseAt[mark] - startedAt])) };
  });
  const remote = ['queue', 'running', 'done'].map(state => {
    const directory = join(home, '.pullboard-runner', state);
    const names = jobNames(directory);
    return { state, count: names.length, jobs: names.slice(0, LIMIT).map(id => {
      const tail = boundedText(join(directory, id, 'control.log'), 65536, true);
      return { job: identity(id), observedMarkersInTail: ['NEED', 'READY', 'RESULT'].filter(marker => tail.includes(`PULLBOARD_RUNNER_${marker} `)),
        sourceSent: existsSync(join(directory, id, 'source.pack.ready')) };
    }) };
  });
  const phases = boundedText(requests + '.phases').split('\n');
  return { version: 1, observedAfterChildMs: Date.now() - startedAt, controller: { count: records.length, jobs: controller }, remote,
    transports: { dispatched: phases.filter(line => line === 'dispatched').length, returned: phases.filter(line => line === 'returned').length },
    pools: { controller: poolCounts(join(machineHome, 'resources.sqlite')), worker: poolCounts(join(home, '.pullboard', 'resources.sqlite')),
      sourceCache: poolCounts(join(home, '.pullboard-runner', 'cache', 'resource-pool', 'resources.sqlite')) } };
}
