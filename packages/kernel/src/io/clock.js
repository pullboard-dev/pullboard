/** The one place that reads the real clock: Date.now and timeouts, behind an injectable source [C7]. */

/** The real source, the only place a timer or Date.now is touched. */
const REAL_SOURCE = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle),
});

/** Make a clock that returns whatever its source returns; the real source by default. */
export function createClock(source = REAL_SOURCE) {
  return Object.freeze({
    now: () => source.now(),
    setTimeout: (fn, ms) => source.setTimeout(fn, ms),
    clearTimeout: handle => source.clearTimeout(handle),
  });
}

/**
 * Make a deterministic clock: time moves only on advance(), which fires due timers in order.
 * Why: logic tests need time they control, never a wall-clock sleep.
 */
export function createFakeClock(start = 0) {
  let current = start;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { fn, at: current + Math.max(0, ms), id });
    return id;
  };
  const source = {
    now: () => current,
    setTimeout: (fn, ms) => add(fn, ms),
    clearTimeout: id => { timers.delete(id); },
  };
  /** Move time forward by ms, running every timer that falls due, earliest first. */
  const advance = ms => {
    const target = current + ms;
    for (;;) {
      const due = [...timers.values()].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      current = due.at;
      timers.delete(due.id);
      due.fn();
    }
    current = target;
  };
  return Object.assign(createClock(source), { advance, pending: () => timers.size });
}
