/**
 * The request thread's loop-lag watchdog: a timer that should fire every tick notices when it fired late, and a lag
 * over the threshold is a stall, reported with the routes whose handling overlapped it [A2,C7]. Why: a handler that
 * blocked the request thread for hours left no trace naming it; a stall record names the route to move off the thread.
 */
import { performance } from 'node:perf_hooks';

/** The lag past which the request thread counts as stalled. */
const STALL_MS = 500;
/** How often the watchdog's timer is due. */
const TICK_MS = 100;
/** How many finished requests the watchdog remembers, to name a route that blocked and answered within one stall. */
const KEPT = 64;

/**
 * Start a watchdog; enter(route) marks a request's start and returns the function that marks its end.
 *
 * @param {{ onStall: (stall: { route: string, routes: string[], lagMs: number }) => void, stallMs?: number, tickMs?: number }} options
 */
export function startLoopWatchdog({ onStall, stallMs = STALL_MS, tickMs = TICK_MS }) {
  const open = new Set();
  const done = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const at = performance.now();
    const lagMs = at - last - tickMs;
    const from = last;
    last = at;
    if (lagMs <= stallMs) return;
    // A route overlapped the stall when it started before the timer fired late and had not finished before it was due.
    const overlapped = [...open, ...done].filter((entry) => entry.start <= at && (entry.end === null || entry.end >= from));
    const routes = [...new Set(overlapped.sort((left, right) => left.start - right.start).map((entry) => entry.route))];
    onStall({ route: routes[0] ?? 'no request', routes, lagMs });
  }, tickMs);
  timer.unref();
  return {
    /** Mark one request's route as being handled; call the returned function when its response ends. */
    enter(route) {
      const entry = { route, start: performance.now(), end: null };
      open.add(entry);
      return () => {
        if (!open.delete(entry)) return;
        entry.end = performance.now();
        done.push(entry);
        if (done.length > KEPT) done.shift();
      };
    },
    /** Stop watching. */
    close() { clearInterval(timer); },
  };
}
