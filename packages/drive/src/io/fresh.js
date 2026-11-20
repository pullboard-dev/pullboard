import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { fileSystemAdapter } from '../../../fs/index.js';
const fs = fileSystemAdapter();

const run = promisify(execFile);

/** @typedef {{ p95: number, cpuMs: number }} TrialFigures The p95 milliseconds per claim and the CPU milliseconds a run of trial claims used. */

/** The new p95 limit in milliseconds, whatever the old process measured. */
const TRIAL_P95_LIMIT_MS = 1_000;
/** How many times the old process's figure a new p95 or CPU may reach before the trial refuses it. */
const TRIAL_FACTOR = 2;

/** Whether the new figures stay inside the trial's limits against the old ones: p95 within 1 s and twice the old, CPU within twice the old. */
export function trialWithinLimits(old, next) {
  return next.p95 <= TRIAL_P95_LIMIT_MS && next.p95 <= old.p95 * TRIAL_FACTOR && next.cpuMs <= old.cpuMs * TRIAL_FACTOR;
}

/**
 * Build the `trial` option of restartOnCodeMove from a claim measurement: `claims({ db, root, count })` runs this process's own claims
 * (the api's trialClaims) and `next(to, { db, root, count })` runs the same count under the new code at `to`.
 * @param {{ claims: (options: { db: string, root: string, count: number }) => TrialFigures, db: string, root: string, count?: number,
 *   next: (to: string, options: { db: string, root: string, count: number }) => TrialFigures | Promise<TrialFigures> }} options
 */
export function claimTrial({ claims, db, root, count = 20, next }) {
  return { old: () => claims({ db, root, count }), next: (to) => next(to, { db, root, count }) };
}

/** Run a trial and say whether the move may go on; a refusal or a trial that cannot run logs its one line and answers false. */
async function trialPasses(trial, to, log) {
  const commit = to.slice(0, 10);
  let old, next;
  try {
    old = await trial.old();
    next = await trial.next(to);
  } catch (error) {
    log(`pullboard: the restart trial for ${commit} could not run (${String(error?.message ?? error).slice(0, 160)}); this process keeps serving`);
    return false;
  }
  if (trialWithinLimits(old, next)) return true;
  log(`pullboard: the restart trial refused ${commit}: new claims p95 ${next.p95.toFixed(2)} ms, cpu ${next.cpuMs.toFixed(2)} ms against this process's p95 ${old.p95.toFixed(2)} ms, cpu ${old.cpuMs.toFixed(2)} ms; this process keeps serving`);
  return false;
}

/**
 * Restart a long-running server on fresh code when the checkout it runs from moves to another commit (#6157).
 * The old server stops listening, lets in-flight requests finish for up to `drain` ms, then calls `relaunch` (the same
 * server on the same port, from the new code) and settles `restarted`, so its caller exits.
 * Why: a process started before a landing lazily imports the landing's modules against the ones it loaded at start,
 * and from 12 Nov 12:15Z every board read failed that way until a hand restart; a fresh process loads one tree.
 * Leases live on the board, never in the process, so a runner's lease outlives the restart.
 * With `affects`, a move that changes nothing the server loads is only noted: no restart and no gap in listening.
 * With `handoff`, `relaunch` runs first and hands the new process this one's listening socket; this one stops accepting
 * only once the new one says it listens, so the port is never unanswered (#6723). A new process that never listens is
 * stopped, and this one keeps serving until the code moves again.
 * With `trial` (serve.restartTrial, off by default), a move is first tried on the board's claim path: the new code's claims and
 * this process's own are measured, and a new p95 over 1 s or over twice this one's, or CPU over twice this one's, keeps this
 * process listening, hands over no socket and starts no new process; one log line names both p95s, both CPUs and the commit,
 * and that commit is not tried again [C7,#12118]. A trial that cannot run keeps this process too, the same way.
 *
 * @param {{ root: string, revision: () => string | null, close: () => Promise<unknown>, handoff?: boolean,
 *   relaunch: () => Promise<{ pid: number | null, listening?: boolean }> | { pid: number | null }, interval?: number, drain?: number,
 *   affects?: (from: string, to: string) => boolean | Promise<boolean>, trial?: { old: () => TrialFigures | Promise<TrialFigures>, next: (to: string) => TrialFigures | Promise<TrialFigures> } | null,
 *   log?: (line: string) => void }} options revision reads the commit the code at root is at, null when it cannot tell; trial: the claims this process measures on itself and the claims the new code at `to` measures.
 * @returns {{ restarted: Promise<{ from: string, to: string, pid: number | null }>, stop: () => void }}
 */
export function restartOnCodeMove({ root, revision, close, relaunch, handoff = false, affects = () => true, trial = null, interval = 5_000, drain = 20_000, log = (line) => process.stderr.write(line + '\n') }) {
  let from = revision();
  let timer = null;
  let settle;
  const restarted = new Promise((done) => { settle = done; });
  const check = async () => {
    timer = null;
    const to = revision();
    if (!to || to === from) { schedule(); return; }
    if (!await affects(from, to)) { from = to; schedule(); return; }
    if (trial && !await trialPasses(trial, to, log)) { from = to; schedule(); return; }
    log(`pullboard: the code at ${root} moved from ${from.slice(0, 10)} to ${to.slice(0, 10)}; restarting on the new code`);
    const early = handoff ? await relaunch() : null;
    if (early && !early.listening) {
      log(`pullboard: the new process never listened; this one keeps serving until the code moves again`);
      from = to; schedule(); return;
    }
    let drained;
    await Promise.race([close(), new Promise((done) => { drained = setTimeout(done, drain); })]);
    clearTimeout(drained);
    const { pid } = early ?? await relaunch();
    log(`pullboard: restarted as process ${pid ?? 'unknown'}`);
    settle({ from, to, pid });
  };
  const schedule = () => { timer = setTimeout(check, interval); timer.unref(); };
  // Code outside a Git checkout has no commit to watch: it serves as it did.
  if (from) schedule();
  return { restarted, stop: () => { if (timer) clearTimeout(timer); timer = null; } };
}

/** Relative import, dynamic import and require specifiers a module names literally. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu;

/** Every file a server started from `entries` can load: the relative imports and requires it names, followed to a fixed point. */
export function servedClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = resolve(queue.pop());
    if (seen.has(file) || !fs.exists(file)) continue;
    seen.add(file);
    if (!/\.(?:m?js|cjs)$/u.test(file)) continue;
    let text;
    try { text = fs.readFile(file, 'utf8'); } catch { continue; }
    for (const match of text.matchAll(SPECIFIER)) queue.push(join(dirname(file), match[1]));
  }
  return seen;
}

/**
 * The `affects` rule for a server run from `entries` in the checkout at `root`: a landing restarts it only when it changes
 * a file in the server's module closure, or package.json. Docs and unrelated cells change nothing the process loaded.
 * Anything it cannot tell (Git failing) restarts, as before.
 * @returns {(from: string, to: string) => Promise<boolean>}
 */
export function servedModuleMoved({ root, entries }) {
  return async (from, to) => {
    let changed;
    try { changed = (await run('git', ['diff', '--name-only', '--no-renames', from, to], { cwd: root })).stdout.split('\n').filter(Boolean); }
    catch { return true; }
    const served = new Set([...servedClosure(entries)].map(file => relative(root, file)));
    return changed.some(file => file === 'package.json' || served.has(file) || !fs.exists(join(root, file)));
  };
}
