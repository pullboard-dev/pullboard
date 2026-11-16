/** A test run whose owner is gone, or that outlives its file time budget, is stopped and recorded once [C7]. */
import { execFile } from 'node:child_process';

/** A test file's default time budget (packages/gate test-file-budget.js, 600 s) plus a margin before a run counts as stale. */
export const STALE_TEST_AFTER_MS = 600_000 + 300_000;

/** A runner job's processes are owned by the runner daemon, so a parent of launchd/init is normal for them. */
const RUNNER_JOB = /\.pullboard-runner\/jobs\//u;

/**
 * A `pullboard test --test-run` driver is spawned detached by design, so a parent of launchd/init is normal for it;
 * its lease lapses and the queue ends it as lost if it dies, so the sweep never stops it, orphaned or old.
 * Why old too: a driver waits on its runner job, which runs past 15 minutes on a loaded runner; the age rule killed
 * live drivers and their runs read "the worker stopped before recording it" (#8193). Its test processes stay swept.
 * A `pullboard test --census` process is such a driver too: it only waits on its shards' runner jobs, and the age rule
 * killed it at about 17 minutes, so every shard still running got no rows (#8305).
 */
const TEST_RUN_DRIVER = /pullboard\.js\s+test\s+(?:--test-run\s|(?:\S+\s+)*--census\b)/u;

/** Only node processes are swept: a shell whose command line merely mentions a test command is an agent's shell. */
const NODE_PROCESS = /^(?:\S*\/)?node(?:\s|$)/u;

/** The census of processes Pullboard launches to run tests: the test command, the runner and a test-file child. */
const TEST_COMMAND = /(?:pullboard\.js\s+test\b|run-tests\.js|\bnode\b\s+(?:\S+\s+)*--test\b)/u;

/**
 * Parse `ps` elapsed time ([[dd-]hh:]mm:ss) into milliseconds.
 *
 * @param {string} text - The etime column.
 * @returns {number} Elapsed milliseconds, or NaN when the text is not a ps elapsed time.
 */
export function elapsedMs(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(text);
  if (!match) return NaN;
  const [days, hours, minutes, seconds] = [match[1], match[2], match[3], match[4]].map(value => Number(value ?? 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * Read this machine's process census: pid, parent pid, elapsed time and command line.
 * Why async: the sweep runs from lease work, where a blocking `ps` would stall the lease timer.
 *
 * @returns {Promise<Array<{ pid: number, ppid: number, ageMs: number, command: string }>>} One row per process; empty when ps is unreadable.
 */
export function readProcesses() {
  return new Promise(resolve => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 }, (error, output) => {
      if (error) { resolve([]); return; /* An unreadable census stops nothing. */ }
      resolve(output.split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), ageMs: elapsedMs(match[3]), command: match[4] }] : [];
      }));
    });
  });
}

/**
 * Stop every test process whose launching process is gone (reparented to launchd or init) or that has run past its
 * budget plus a margin. A run whose owner is alive and within budget is never touched, nor is this process or any
 * ancestor of it, a detached `--test-run` driver at any age, or a non-node process such as an agent's shell. The caller records one event per stop (liveness.js owns the event table).
 *
 * @param {{ processes: Array<object>, stop?: (pid: number) => void, afterMs?: number, own?: number, only?: (row: object) => boolean }} options
 *   processes is the census and stop the signal; only narrows the census (a test's private marker).
 * @returns {Array<{ pid: number, command: string, reason: string }>} The processes stopped.
 */
export function sweepStaleTests({ processes, stop = pid => process.kill(pid, 'SIGTERM'), afterMs = STALE_TEST_AFTER_MS, own = process.pid, only = () => true }) {
  const byPid = new Map(processes.map(row => [row.pid, row]));
  const protectedPids = new Set();
  for (let pid = own; pid && byPid.has(pid) && !protectedPids.has(pid); pid = byPid.get(pid).ppid) protectedPids.add(pid);
  const stopped = [];
  for (const row of processes) {
    if (!NODE_PROCESS.test(row.command) || !TEST_COMMAND.test(row.command) || TEST_RUN_DRIVER.test(row.command) || protectedPids.has(row.pid) || !only(row)) continue;
    const orphan = row.ppid === 1 && !RUNNER_JOB.test(row.command);
    const reason = orphan ? 'its launching process is gone (parent is launchd/init)'
      : row.ageMs > afterMs ? `it ran ${Math.round(row.ageMs / 1000)} s, past its ${Math.round(afterMs / 1000)} s file budget plus margin` : null;
    if (!reason) continue;
    try { stop(row.pid); } catch (error) { if (error.code !== 'ESRCH') continue; }
    stopped.push({ pid: row.pid, command: row.command, reason });
  }
  return stopped;
}

/**
 * Whether this process may sweep the machine: a process inside a test run (its sandbox, runner pid or node:test context
 * is set) shares the machine with other test files' live processes and must never stop them.
 *
 * @param {NodeJS.ProcessEnv} [env] - The environment to read.
 * @returns {boolean} True outside every test run.
 */
export function sweepAllowed(env = process.env) {
  return !(env.PULLBOARD_TEST_RUNNER_PID || env.PULLBOARD_TEST_SANDBOX || env.NODE_TEST_CONTEXT);
}

/**
 * Read the census and stop the stale test processes in it.
 *
 * @returns {Promise<Array<{ pid: number, command: string, reason: string }>>} The processes stopped; empty when the census fails.
 */
export async function scanStaleTests() {
  try { return sweepStaleTests({ processes: await readProcesses() }); } catch { return []; /* A census failure never blocks the queue. */ }
}

/**
 * Record one event per stopped test process, naming its pid, command and reason.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The open slot database inside the caller's write transaction.
 * @param {Array<{ pid: number, command: string, reason: string }>} stops - The processes the sweep stopped.
 * @param {(db: object, kind: string, row: object, detail: string) => void} record - The liveness event writer.
 */
export function recordStaleStops(db, stops, record) {
  for (const stop of stops) record(db, 'stale-test-stopped', { name: 'test-process', pid: stop.pid }, `${stop.command.slice(0, 300)}; ${stop.reason}`);
}

/** The machine sweep runs at most this often, on the cadence of lease expiry. */
const SWEEP_EVERY_MS = 60_000;

/**
 * A sweeper for one process: each lease pass records the stops its previous scan finished, then starts the next scan when due.
 * Why two steps: the census is read asynchronously, so its stops are written by the next pass inside a transaction.
 * A process inside a test run never scans, because it shares the machine with other test files' live processes.
 *
 * @returns {{ pass: (db: object, record: Function, now?: number) => void }} The per-pass entry.
 */
export function staleTestSweeper() {
  let last = 0;
  const stopped = [];
  return { pass(db, record, now = Date.now()) {
    recordStaleStops(db, stopped.splice(0), record);
    if (!sweepAllowed() || now - last < SWEEP_EVERY_MS) return;
    last = now;
    scanStaleTests().then(stops => { stopped.push(...stops); });
  } };
}
