/**
 * Process start identities for lease liveness, read before a resource write turn and never during one [C7].
 * Why: every queue turn ran the liveness sweep inside its write transaction, and each holder or controller identity
 * past the 3 s cache spawned its own ps. A waiter's cache always expired during its wait, so on 8 Nov each turn spent
 * about 430 ms of its 470 ms on 36 ps spawns, and a line of 70 turns put a runner admission 35 s after its request.
 */
import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { platformIdentity } from './liveness.js';

/** How long an identity read outside a write turn stays current. */
const CACHE_MS = 3_000;
/** Inside a write turn an older read still answers, since the turn's own wait may outlast the cache; older is unknown. */
const TURN_CACHE_MS = 600_000;
const identities = new Map();
let turns = 0;

/** Read one PID's identity from the OS now: ps lstart and state, or the platform reader when ps cannot. */
function readIdentity(pid) {
  readIdentities([pid]);
  return identities.get(pid).identity;
}

/** The ps arguments and environment every reader uses, so one format reaches the cache whichever reader filled it. */
const PS_ARGS = pids => ['-o', 'pid=', '-o', 'lstart=', '-o', 'stat=', '-p', pids.join(',')];
const PS_ENV = { TZ: 'UTC', LC_ALL: 'C', LANG: 'C' };

/** Read the listed PIDs with one ps call and cache each; a PID ps does not list is read by the platform reader. */
function readIdentities(pids) {
  let output = '';
  if (process.platform !== 'win32') {
    try {
      output = execFileSync('/bin/ps', PS_ARGS(pids), {
        encoding: 'utf8', env: { ...process.env, ...PS_ENV }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
      });
    } catch (error) { output = typeof error?.stdout === 'string' ? error.stdout : ''; }
  }
  rememberOutput(pids, output);
}

/** Cache one ps answer for these PIDs; a PID the answer does not list is read by the platform reader. */
function rememberOutput(pids, output) {
  const listed = new Map();
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/u);
    const pid = Number(fields.shift());
    if (Number.isSafeInteger(pid) && fields.length >= 2) listed.set(pid, parsedIdentity(fields));
  }
  for (const pid of pids) remember(pid, listed.has(pid) ? listed.get(pid) : platformIdentity(pid));
}

/** Run ps for these PIDs as a child process without blocking the event loop; what it printed, or nothing when it failed. */
function psOutputAsync(pids) {
  return new Promise(resolve => {
    if (process.platform === 'win32') return resolve('');
    execFile('/bin/ps', PS_ARGS(pids), { encoding: 'utf8', env: { ...process.env, ...PS_ENV }, timeout: 5_000 },
      (error, stdout) => resolve(typeof stdout === 'string' ? stdout : ''));
  });
}

/** Turn ps lstart and stat fields into an identity; the start keeps the single-spaced form leases record. */
function parsedIdentity(fields) {
  const state = fields.pop();
  return fields.length ? { started: fields.join(' '), zombie: state?.startsWith('Z') ?? false } : null;
}

/** Cache one read and drop expired reads once the cache grows. */
function remember(pid, identity) {
  identities.set(pid, { identity, checkedAt: Date.now() });
  if (identities.size <= 1024) return;
  for (const [cachedPid, entry] of identities) {
    if (Date.now() - entry.checkedAt >= TURN_CACHE_MS) identities.delete(cachedPid);
  }
}

/**
 * Read a stable OS process identity; an unreadable identity is unknown, not proof of death. Inside a write turn it
 * answers from the cache only, and a PID never read is unknown, so its live PID keeps the lease until the next
 * refresh reads it.
 *
 * @param {number} pid
 * @returns {{ started: string, zombie: boolean } | null}
 */
export function processIdentity(pid) {
  const cached = identities.get(pid);
  const age = cached ? Date.now() - cached.checkedAt : Infinity;
  if (age < (turns ? TURN_CACHE_MS : CACHE_MS)) return cached.identity;
  return turns ? null : readIdentity(pid);
}

/**
 * Read one identity past the cache, even inside a write turn. Only a cached mismatch calls it, to confirm a PID was
 * reused before a lease is freed, so a steady line never spawns a probe in its transaction.
 */
export function freshIdentity(pid) {
  identities.delete(pid);
  return readIdentity(pid);
}

/**
 * Read every listed PID whose identity is past the cache with one ps call, before the caller queues for a write turn.
 *
 * @param {Iterable<number>} pids
 */
export function refreshIdentities(pids) {
  const now = Date.now();
  const stale = [...new Set(pids)].filter(pid => Number.isSafeInteger(pid) && pid > 0
    && !(now - (identities.get(pid)?.checkedAt ?? -Infinity) < CACHE_MS));
  if (stale.length) readIdentities(stale);
}

/**
 * The same refresh as refreshIdentities, run as a child process that never blocks the event loop. A caller that can
 * wait calls this before it queues, so the synchronous refresh inside the queue finds every identity current and
 * spawns nothing. Why: a synchronous ps froze a gate worker's timers for as long as ps took, 6-26 s at Mac load 25-33
 * (#3837, 8 Nov).
 *
 * @param {Iterable<number>} pids
 * @param {{ read?: (pids: number[]) => Promise<string> }} [options] - A replacement ps, for tests.
 * @returns {Promise<void>}
 */
export async function refreshIdentitiesAsync(pids, { read = psOutputAsync } = {}) {
  const now = Date.now();
  const stale = [...new Set(pids)].filter(pid => Number.isSafeInteger(pid) && pid > 0
    && !(now - (identities.get(pid)?.checkedAt ?? -Infinity) < CACHE_MS));
  if (stale.length) rememberOutput(stale, await read(stale));
}

/** Run the liveness sweep of a write turn with identities answered from the cache only. */
export function duringWriteTurn(work) {
  turns++;
  try { return work(); } finally { turns--; }
}
