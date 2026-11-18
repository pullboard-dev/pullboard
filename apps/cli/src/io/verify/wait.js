import { Refused } from '../../../../../packages/kernel/index.js';

/** How long a review accept waits on one runner trip before it stops: 45 minutes, or PULLBOARD_REVIEW_WAIT_MS. */
export const REVIEW_WAIT_MS = 45 * 60_000;

/** One still-waiting line a minute. */
export const REVIEW_WAIT_EVERY_MS = 60_000;

/** The wait deadline in milliseconds: PULLBOARD_REVIEW_WAIT_MS when it is a positive integer, otherwise REVIEW_WAIT_MS. */
export function reviewWaitMs(env = process.env) {
  const ms = Number(env.PULLBOARD_REVIEW_WAIT_MS);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : REVIEW_WAIT_MS;
}

const minutes = ms => Math.max(1, Math.round(ms / 60_000));

/**
 * Run one wait of a review accept (a runner check, a main comparison) so the reviewer always sees what it waits on.
 * It says what it waits on and its deadline at the start, says it is still waiting once a minute, and at the deadline
 * aborts the signal it handed the action and rejects with REVIEW_WAIT_DEADLINE, even when the action ignores the signal.
 * Why: verify 10149 accept awaited a 584-file runner check and then a queued main comparison with no line and no
 * deadline for 9+ minutes, twice, and a reviewer could not tell a slow check from a hang [C7,#10935].
 *
 * @param {{ say: (text: string) => void }} io
 * @param {{ item: number|string, what: string, deadlineMs?: number, everyMs?: number, now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function } }} options
 * @param {(signal: AbortSignal) => any} action - The wait itself; it should stop its work when the signal aborts.
 * @returns {Promise<any>} The action's result.
 */
export async function reviewWait(io, { item, what, deadlineMs = reviewWaitMs(), everyMs = REVIEW_WAIT_EVERY_MS, now = Date.now, timers = globalThis }, action) {
  const startedAt = now();
  const controller = new AbortController();
  let settled = false;
  io.say(`#${item} accept waits on ${what}; it gives up after ${minutes(deadlineMs)} min`);
  let beat;
  /** One still-waiting line, then the next one a minute later; the chain ends when the wait settles. */
  const remind = () => {
    beat = timers.setTimeout(() => {
      if (settled) return;
      io.say(`#${item} accept still waiting on ${what}: ${minutes(now() - startedAt)} of ${minutes(deadlineMs)} min`);
      remind();
    }, everyMs);
    beat?.unref?.();
  };
  remind();
  let expire;
  const deadline = new Promise((_, reject) => {
    expire = timers.setTimeout(() => {
      if (settled) return;
      const refused = new Refused('REVIEW_WAIT_DEADLINE', `#${item} accept waited ${minutes(deadlineMs)} min on ${what} and stopped; no verdict was recorded. Run pullboard verify ${item} accept again, or shout the coordinator if the runners stay busy`);
      settled = true; // No still-waiting line after the refusal.
      controller.abort(refused);
      reject(refused);
    }, deadlineMs); // Kept referenced: the accept always ends, with a result or this refusal.
  });
  try { return await Promise.race([Promise.resolve().then(() => action(controller.signal)), deadline]); }
  finally {
    settled = true;
    timers.clearTimeout(beat);
    timers.clearTimeout(expire);
  }
}
