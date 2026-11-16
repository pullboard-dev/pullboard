import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { cellsInventoryJob } from '../../../../../packages/drive/index.js';
import { readAcceptedCells } from '../../../../../packages/gate/index.js';
import { recordAcceptedCellsFailure } from '../../../../../packages/gate/index.js';
import { toolingIsPinned } from '../../../../../packages/gate/index.js';
import { warmAcceptedCells } from '../../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../../packages/landing/index.js';
import { withFileLock } from '../../../../../packages/outbox/index.js';

/**
 * Run the pinned checkout's main-audit entry without blocking this process's event loop.
 * Why: the cells-inventory job renews its lease on a timer in this process. The producer runs for minutes, and a
 * blocking spawn froze that timer, so the 2 minute lease lapsed while the producer was alive, a second driver took
 * the job and produced a duplicate, and a driver killed mid-run left the job at produce.started (#3529).
 * @param {string} checkout absolute path of the pinned commit's checkout
 * @param {string} root absolute repository root
 * @param {string} token native UUID token the entry was started with
 * @param {string} commit the pinned commit to produce for
 * @returns {Promise<{ status: number | null, stderr: string }>} the entry's exit status and its stderr
 */
function runPinnedProducer(checkout, root, token, commit) {
  return new Promise(done => {
    const child = spawn(process.execPath, [join(checkout, 'apps/cli/src/io/landing/audit.js'), root, token, '--cells-only', commit],
      { cwd: checkout, env: { ...process.env, PULLBOARD_CELLS_PINNED: commit }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.once('error', error => done({ status: null, stderr: String(error.message) }));
    child.once('close', status => done({ status, stderr }));
  });
}

/**
 * Produce the accepted inventory with the pinned commit's own tooling. When this process runs another snapshot of the
 * tooling (the seat that nudged it), re-run the main-audit entry from a checkout of the pinned commit, so the recorded
 * checker and preload fingerprints are the pinned main's whichever seat started the producer.
 * It lives here, not in apps/cli/src/io/landing/audit.js, so the bin file stays a thin process entry [C7].
 * @param {string} root absolute repository root
 * @param {string} token native UUID token the entry was started with
 * @param {string} commit the pinned commit to produce for
 * @returns {Promise<unknown>} the warm result, or the re-run result
 */
export async function produceAcceptedCells(root, token, commit) {
  if (toolingIsPinned(root, commit)) return warmAcceptedCells(root, commit, { withCheckout: withMainCheckout, withLock: withFileLock });
  if (process.env.PULLBOARD_CELLS_PINNED === commit) throw new Error('the pinned checkout did not carry the pinned tooling');
  const ran = await withMainCheckout(root, commit, checkout => runPinnedProducer(checkout, root, token, commit));
  if (ran?.unavailable || ran?.status !== 0) throw new Error(ran?.unavailable ?? `accepted cells producer failed in the pinned checkout: ${String(ran?.stderr ?? '').split('\n').filter(line => /Error/u.test(line)).slice(0, 2).join(' ').slice(0, 600)}`);
  return ran;
}

/** The accepted-inventory ports the cells backlog collector reads, warms and records through; codemap sits below these cells [C7]. */
export const acceptedCellsPorts = Object.freeze({
  read: readAcceptedCells,
  warm: (root, commit) => warmAcceptedCells(root, commit, { withCheckout: withMainCheckout, withLock: withFileLock }),
  record: recordAcceptedCellsFailure,
});

/** How long a gate waits on another driver's lease of the same tree's inventory job before it stops as pending. */
const INVENTORY_WAIT_MS = 15 * 60_000;

/** The retryable stop a gate ends with when the inventory is still not readable, carrying its commit. */
function inventoryPending(commit, message) {
  return Object.assign(new Error(`accepted cells inventory for ${commit.slice(0, 12)} ${message}`),
    { name: 'CellsInventoryInfrastructureError', code: 'CELLS_INVENTORY_PENDING', retryable: true, commit });
}

/**
 * Get a commit's accepted cells inventory through its cells-inventory job, keyed by the tree id: the artifact when it
 * is already readable (`waited` 0), else the job's stored result, else the job taken and produced here under its
 * lease, else a wait on the lease of the driver producing it. Returns the readable artifact with `waited` 1 once the
 * job made it readable; throws a CELLS_INVENTORY_PENDING stop naming the commit when it still is not.
 *
 * Why: no process is load-bearing (RFC 0008 DJ21). A gate used to nudge a detached producer and poll its owner
 * file; a killed producer stalled every gate on that tree (CELLS_INVENTORY_PENDING, 6 Nov). The job row now holds
 * who produces and what was produced, so any driver resumes it. The drive cell never imports the gate cell, so
 * the producer is passed in as `produce` from here.
 * `runs` is the board's runs holder (boardRunsHolder) while runs_store is on: the inventory job's rows then live in the
 * runs file and are read from it; null (the default, flag off) keeps them on the board [P7,#9112].
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle.
 * @param {string} root - Absolute repository root.
 * @param {string} commit - The pinned main commit whose inventory the gate needs.
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync } | null, owner?: string, read?: (root: string, commit: string) => any, produce?: (root: string, commit: string) => Promise<unknown>,
 *   beat?: (line: string) => void, waitMs?: number, now?: () => number, sleep?: (ms: number) => Promise<unknown>, pollMs?: number, renewMs?: number }} [options]
 * @returns {Promise<{ available: true, waited: number, job?: string, state?: string }>}
 */
export async function acceptedCellsFromJob(db, root, commit, { owner = `gate:${process.pid}:${randomUUID()}`, read = readAcceptedCells,
  produce = (repo, pinned) => produceAcceptedCells(repo, randomUUID(), pinned), beat = () => {}, waitMs = INVENTORY_WAIT_MS, sleep, runs = null, ...options } = {}) {
  const ready = read(root, commit);
  if (ready.available) return { ...ready, waited: 0 };
  /** Produce the artifact unless another driver already published it, and return the job's small JSON result. */
  const make = async ({ key }) => {
    if (!read(root, commit).available) {
      try { await produce(root, commit); }
      catch (error) { try { recordAcceptedCellsFailure(root, commit, error); } catch { /* Keep the producer's own failure. */ } throw error; }
    }
    const made = read(root, commit);
    if (!made.available) throw inventoryPending(commit, `was not readable after its cells-inventory job produced it (${made.cause})`);
    return { tree: key, commit, digest: made.descriptor?.digest ?? null, bytes: made.bytes ?? null };
  };
  /** Each wait on another driver's lease beats, so the job log shows the gate is alive. */
  const pause = sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const waitBeat = async ms => { beat(`accepted cells inventory for ${commit.slice(0, 12)} is being produced by another driver's cells-inventory job; waiting on its lease`); return pause(ms); };
  const job = await cellsInventoryJob(db, { ...options, runs, repo: root, commit, owner, produce: make, waitMs, sleep: waitBeat });
  if (job.state === 'pending') throw inventoryPending(commit, `is still being produced by ${job.holder ?? 'another driver'} after ${Math.round(waitMs / 1000)} s (job ${job.job}); requeue after its cells-inventory job finishes`);
  const found = read(root, commit);
  if (found.available) return { ...found, waited: 1, job: job.job, state: job.state };
  // A stored result whose artifact is not on this machine: rebuild it here, since a derived result is rebuilt when missing.
  await make({ key: job.key });
  return { ...read(root, commit), waited: 1, job: job.job, state: 'rebuilt' };
}
