/** A short per-item review lease beside the board, so seats racing for one review wait on a file, not on the board's one write lock [C7,#11110]. */
import { closeSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { Refused } from '../../../../../packages/kernel/index.js';

/** How long a lease, or the mark of a taken review, stays live. */
const LEASE_MS = 5_000;
/** The longest a seat waits on another seat's lease before it goes on to a build. */
const WAIT_MS = 10_000;
const POLL_MS = 50;

/** Whether a process still exists; a process another user owns still counts as alive. */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Read a lease file; null when it is gone or half-written. */
function readLease(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Remove a lease file; a file already gone is fine. */
function dropLease(file) {
  try { unlinkSync(file); } catch { /* another seat already reclaimed it */ }
}

/**
 * Run one review reservation under the item's lease. The first seat creates the lease file exclusively (pid, start,
 * expiry) and runs `work`; every other seat waits on that file, never on the board lock. When the holder's work
 * succeeds the file stays as a short "taken" mark, so a waiter is refused REVIEW_HELD without calling `work` at all
 * and its `next` goes on to a build. A lease whose pid is gone, or that has run out, is reclaimed at once.
 *
 * @param {string} boardFile - the board database path; the lease sits in the same folder
 * @param {number|string} itemId
 * @param {() => Promise<any>|any} work - the board write that reserves the review
 * @param {{ holder?: string, now?: () => number, alive?: (pid: number) => boolean, sleep?: (ms: number) => Promise<void>, pid?: number, leaseMs?: number, waitMs?: number, pollMs?: number }} [options]
 *   holder: the reserving seat; it is never refused by its own taken mark, so renewing a reservation still works
 * @returns {Promise<any>} what `work` returns
 */
export async function withReviewLease(boardFile, itemId, work, options = {}) {
  const { holder = null, now = Date.now, alive = pidAlive, pid = process.pid, leaseMs = LEASE_MS, waitMs = WAIT_MS, pollMs = POLL_MS,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  const file = join(dirname(boardFile), `review-lease-${itemId}.json`);
  const deadline = now() + waitMs;
  // Each pass either takes the file, reclaims a stale one, refuses, or sleeps one poll; the pass count bounds the wait however the clock moves.
  let created = false;
  for (let pass = 0; !created && pass < Math.ceil(waitMs / pollMs) + 8; pass += 1) {
    try {
      const fd = openSync(file, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid, start: now(), expires: now() + leaseMs, holder })); created = true; } finally { closeSync(fd); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (created) break;
    const lease = readLease(file);
    // A file still being written has no content yet: look again shortly.
    if (lease && lease.taken && (lease.expires <= now() || lease.holder === holder)) dropLease(file);
    else if (lease && lease.taken) throw new Refused('REVIEW_HELD', `${lease.holder ?? 'another seat'} holds the review of #${itemId}; it was just reserved`);
    else if (lease && (lease.expires <= now() || !alive(lease.pid))) dropLease(file);
    else if (now() >= deadline) throw new Refused('REVIEW_HELD', `${lease.holder ?? 'another seat'} holds the review of #${itemId}; it is still being reserved`);
    else await sleep(pollMs);
  }
  if (!created) throw new Refused('REVIEW_HELD', `another seat is still reserving the review of #${itemId}`);
  try {
    const result = await work();
    writeFileSync(file, JSON.stringify({ pid, start: now(), expires: now() + leaseMs, holder, taken: true }));
    return result;
  } catch (error) {
    dropLease(file);
    throw error;
  }
}

/**
 * The ordered port with its reserveReview move run under the item's review lease; every other move passes through.
 *
 * @param {(ctx: any, board: any, operation: string, args: any[], options?: any) => Promise<any>} ordered
 * @param {(ctx: any) => string} boardFileOf
 * @returns {(ctx: any, board: any, operation: string, args: any[], options?: any) => Promise<any>}
 */
export function leasedOrdered(ordered, boardFileOf) {
  return (ctx, board, operation, args, options) => operation === 'reserveReview'
    ? withReviewLease(boardFileOf(ctx), args[0], () => ordered(ctx, board, operation, args, options), { holder: args[1]?.agentId })
    : ordered(ctx, board, operation, args, options);
}
