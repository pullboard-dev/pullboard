import { environmentAdapter } from '../../../../env/index.js';
import { execFile } from 'node:child_process';

/** The environment this file reads, through the one adapter [C7]. */
const environment = environmentAdapter();

/** A land job's check deadline: how long its proof may run, and how its process tree is stopped when it runs past [C7,#7820]. */

/** The named result a landing proof that ran past its deadline posts, and the receipt outcome the board offers the landing again for. */
export const LAND_PROOF_TIMEOUT = 'LAND_PROOF_TIMEOUT';
// Budget: the proof limit when neither the board's pushGate.shardMinutes nor a runner ceiling names one, like the runner's per-job ceiling (packages/runners RUN_CEILING_MS).
const DEFAULT_PROOF_MINUTES = 20;
// Budget: a stopped proof tree gets this long to exit on SIGTERM before the whole group is killed.
const KILL_GRACE_MS = 3_000;

/**
 * How long a landing's checks may run in all: the offer's `proofMinutes` (the board's pushGate.shardMinutes, 20 by
 * default), or a longer PULLBOARD_RUNNER_RUN_CEILING_MS on this runner, as the push gate's own limit is. Null when the
 * runner ceiling is 0 (off). Why: renewals keep a land job's lease alive for as long as its proof runs, so a hung or
 * crawling proof blocked its items with no red, no re-offer and no message (#7820).
 *
 * @param {{ proofMinutes?: number }} payload
 * @param {Record<string, string|undefined>} [env]
 * @returns {number | null} Milliseconds.
 */
export function proofLimitMs(payload, env = environment.all()) {
  const raw = env.PULLBOARD_RUNNER_RUN_CEILING_MS;
  if (raw === '0') return null;
  const minutes = Number.isFinite(payload?.proofMinutes) && payload.proofMinutes > 0 ? payload.proofMinutes : DEFAULT_PROOF_MINUTES;
  const runner = raw === undefined || raw === '' ? 0 : Number(raw);
  return Math.max(minutes * 60_000, Number.isSafeInteger(runner) && runner > 0 ? runner : 0);
}

/** The pids of `root` and everything under it by parent links, from one process table read; just `root` when ps cannot run. */
function tree(root) {
  return new Promise(resolve => {
    execFile('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 32 << 20 }, (error, rows) => {
      if (error) return resolve([root]);
      const children = new Map();
      for (const row of rows.split('\n')) {
        const found = /^\s*(\d+)\s+(\d+)\s*$/u.exec(row);
        if (found) children.set(Number(found[2]), [...children.get(Number(found[2])) ?? [], Number(found[1])]);
      }
      const all = [root];
      for (let at = 0; at < all.length; at++) all.push(...children.get(all[at]) ?? []);
      resolve(all);
    });
  });
}

/** Whether a process exists. */
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Stop a child's whole process tree and return once it is gone: SIGTERM to each process, then SIGKILL to what is left
 * after the grace. Why a tree: the proof is a shell that runs run-tests, which runs each test file, which may start a view
 * or a browser; stopping only the shell left them running. The runner's own end-of-job sweep takes any that were
 * reparented away from the tree [#7819,#7820].
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
export async function stopTree(child) {
  const kill = (pids, signal) => { for (const pid of pids) { try { process.kill(pid, signal); } catch { /* already gone */ } } };
  const seen = await tree(child.pid);
  kill([...seen].reverse(), 'SIGTERM');
  for (const until = Date.now() + KILL_GRACE_MS; seen.some(alive) && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 100));
  kill([...new Set([...seen, ...await tree(child.pid)])], 'SIGKILL');
}

/**
 * Run `onTimeout` and stop the child's tree when the deadline `deadline()` names (`{ at, ms }`: an epoch ms and the
 * whole limit, or null for none) passes before the returned `clear` is called. Read when the child starts, so a deadline
 * set after the part was built still counts.
 * @param {import('node:child_process').ChildProcess} child
 * @param {(() => { at: number, ms: number } | null) | null | undefined} deadline
 * @param {(limitMs: number) => (() => void) | void} onTimeout - called first, so the check's own close is already ignored; the function it returns runs once the tree is gone.
 * @returns {() => void} clear
 */
export function watchDeadline(child, deadline, onTimeout) {
  const set = deadline?.() ?? null;
  if (!set) return () => {};
  const timer = setTimeout(async () => { const done = onTimeout(set.ms); await stopTree(child); done?.(); }, Math.max(0, set.at - Date.now()));
  return () => clearTimeout(timer);
}

/** The detail a timed-out check posts: the code, the limit and what the check had shown. */
export function timeoutDetail(what, limitMs, tail = '') {
  const minutes = Math.round(limitMs / 60_000 * 10) / 10;
  return `${LAND_PROOF_TIMEOUT}: ${what} ran past the landing's ${minutes}-minute limit and its process tree was stopped; to allow a longer run, raise pushGate.shardMinutes in pullboard.json and PULLBOARD_RUNNER_RUN_CEILING_MS on the runners${tail ? `\n… ${tail.slice(-300)}` : ''}`;
}
