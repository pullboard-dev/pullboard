/** Sample cumulative CPU for a test process and its live descendants [C7,V10]. */
import { execFile } from 'node:child_process';

/** Parse POSIX ps CPU times with optional hours and fractional seconds. */
function micros(value) {
  const parts = value.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part) || part < 0)) return null;
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1_000_000);
}

/**
 * A failed or malformed census is unknown, never evidence that the tree is idle. Why async: the loop runs in the drive
 * cell, where a synchronous child process would stall the thread's timers for the length of the census.
 */
export function processTreeCpu(root) {
  return new Promise((done) => {
    const child = execFile('ps', ['-axo', 'pid=,ppid=,lstart=,time='], { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => done(error ? null : treeFromCensus(stdout, root, child.pid)));
  });
}

/**
 * The live descendants of `root` from one ps census, deepest first, so a hung file's holders of its output can be stopped.
 * Why: a killed worker whose grandchild still holds the output pipe leaves the run waiting on the pipe, not the exit.
 */
export function processTreeDescendants(root) {
  return new Promise((done) => {
    const child = execFile('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return done([]);
        const parents = new Map();
        for (const line of stdout.split('\n')) {
          const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
          if (match && Number(match[1]) !== child.pid) parents.set(Number(match[1]), Number(match[2]));
        }
        const reached = [root];
        for (let index = 0; index < reached.length; index++) {
          for (const [pid, ppid] of parents) if (ppid === reached[index] && !reached.includes(pid)) reached.push(pid);
        }
        done(reached.slice(1).reverse());
      });
  });
}

/** The CPU of `root` and its live descendants from one ps census, leaving out the census process `self`. */
function treeFromCensus(stdout, root, self) {
  const rows = new Map();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s*$/u.exec(line);
    if (!match) return null;
    const pid = Number(match[1]), ppid = Number(match[2]), cpu = micros(match[4]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || cpu === null || rows.has(pid)) return null;
    rows.set(pid, { pid, ppid, key: `${pid}:${match[3]}`, cpu });
  }
  if (!rows.has(root)) return null;
  const reached = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows.values()) if (row.pid !== self && reached.has(row.ppid) && !reached.has(row.pid)) {
      reached.add(row.pid); changed = true;
    }
  }
  return new Map([...reached].filter(pid => pid !== self).map(pid => {
    const row = rows.get(pid); return [row.key, row.cpu];
  }));
}

/** Count work observed on live identities, including newly seen children and never a reused PID. */
export function treeCpuDelta(previous, current) {
  let total = 0;
  for (const [key, value] of current) total += Math.max(0, value - (previous.get(key) ?? 0));
  return total;
}
