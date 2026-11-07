/** What a person sees once a pullboard test run is admitted: where it runs, then a progress line each minute [C7,#3439]. */

/** The default gap between progress lines, in milliseconds. */
export const PROGRESS_MS = 60_000;

/**
 * Print the admission line and start the progress timer; the returned function stops the timer.
 * The runner returns results only when the run ends, so a progress line names the files running, not a count done.
 *
 * @param {(line: string) => void} say where lines go
 * @param {{ host?: string, files: string[], intervalMs?: number, now?: () => number, setTimer?: Function, clearTimer?: Function }} facts
 * @returns {() => void}
 */
export function announceTestRun(say, { host, files, intervalMs = PROGRESS_MS, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  const started = now();
  say(`admitted on ${host || 'this machine'}: running ${count}: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', ...' : ''}`);
  const timer = setTimer(() => {
    say(`still running on ${host || 'this machine'}: ${Math.round((now() - started) / 1000)}s elapsed, ${count} running, results arrive when the run ends`);
  }, intervalMs);
  timer.unref?.();
  return () => clearTimer(timer);
}
