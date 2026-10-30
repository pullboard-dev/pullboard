/** Answer the controller's health request from the worker's own runner root [C7]. */
import { runnerHealthReply } from './runner-transport.js';
import { runnerIdleReply } from './runner-transport.js';
import { parseProcessCensus } from '../packages/kernel/src/core/process-census.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';

/** Print one health or idle reply for a base64 request, exiting non-zero when the request is not exact. */
export function serveHealth(encodedRequest) {
  try {
    const { request, root } = readRequest(encodedRequest);
    process.stdout.write(JSON.stringify(request.idle === true ? runnerIdleReply(root, request) : runnerHealthReply(root, request)) + '\n');
  } catch { process.exitCode = 1; }
}

/** Decode and validate one base64 health request and resolve the runner root it names. */
function readRequest(encodedRequest) {
  const request = JSON.parse(Buffer.from(encodedRequest ?? '', 'base64').toString('utf8'));
  if (!/^[a-f0-9-]{36}$/u.test(request.nonce ?? '') || request.root !== undefined && !isAbsolute(request.root)) throw new Error('invalid health request');
  return { request, root: request.root ?? join(isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir, '.pullboard-runner') };
}

/**
 * List pinned worker processes that run no job: not this process, not a --health probe, and not the owner of any job directory.
 * Returns null when a job owner is alive, a resource lease is active or the process table cannot be trusted, because
 * restarting then could kill real work (#2035).
 */
export function idleWorkerPids(root) {
  const ps = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,args='], { encoding: 'utf8', timeout: 2_000,
    maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } });
  if (ps.error || ps.status !== 0 || ps.signal) return null;
  const census = parseProcessCensus(ps.stdout);
  if (!census) return null;
  const canonical = realpathSync(root);
  const roots = [...new Set([root, canonical])].map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const entry = new RegExp('(?:' + roots.join('|') + ')/runtime/[a-f0-9]{64}/src/runner-worker\\.js(?=\\s|$)', 'u');
  const owners = new Set();
  let directories = [];
  try { directories = readdirSync(join(canonical, 'jobs'), { withFileTypes: true }); } catch { /* No jobs directory means no job owner. */ }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    try { owners.add(JSON.parse(readFileSync(join(canonical, 'jobs', directory.name, 'worker-owner.json'), 'utf8')).pid); }
    catch (error) { if (error.code !== 'ENOENT') return null; }
  }
  const home = isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir;
  try {
    const db = new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME ?? join(home, '.pullboard'), 'resources.sqlite'), { readOnly: true });
    try { if (db.prepare("SELECT 1 FROM holder WHERE name='gate' OR agent LIKE 'pullboard-ssh-%' LIMIT 1").get()) return null; }
    finally { db.close(); }
  } catch (error) { if (error.code !== 'ERR_SQLITE_ERROR' && error.code !== 'ENOENT') return null; }
  const stale = [];
  for (const line of ps.stdout.trim().split('\n')) {
    const row = /^\s*([1-9][0-9]*)\s+\d+\s+\d+\s+[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s+(\S+)\s+(.+)$/u.exec(line);
    const pid = Number(row?.[1]), worker = row && entry.exec(row[3]);
    if (!worker || pid === process.pid || row[2].startsWith('Z') || /^\s+--health(?:\s|$)/u.test(row[3].slice(worker.index + worker[0].length))) continue;
    if (owners.has(pid)) return null;
    stale.push(pid);
  }
  return stale;
}

/**
 * Restart an idle runner's worker: end every pinned worker process that runs no job, then answer the idle proof
 * with the pids it ended. A busy runner is left alone and the idle proof names the live owner (#2035).
 */
export function serveRestart(encodedRequest) {
  try {
    const { request, root } = readRequest(encodedRequest);
    const stale = idleWorkerPids(root) ?? [];
    for (const pid of stale) { try { process.kill(pid, 'SIGTERM'); } catch { /* Already gone. */ } }
    if (stale.length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    for (const pid of stale) { try { process.kill(pid, 'SIGKILL'); } catch { /* Ended on SIGTERM. */ } }
    process.stdout.write(JSON.stringify({ ...runnerIdleReply(root, request), restarted: stale }) + '\n');
  } catch { process.exitCode = 1; }
}
