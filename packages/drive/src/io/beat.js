/**
 * A steady beat for a long-lived caller: `beat` runs every `everyMs` until `stop`, and the timer never keeps the process alive.
 *
 * Why: the serve loop's reconciler needs a heartbeat, and a loop that never ends on its own belongs to the drive cell [B2,P7].
 *
 * @param {() => void} beat - One beat; it must catch its own errors.
 * @param {number} everyMs - The gap between beats.
 * @returns {{ stop: () => void }}
 */
export function startBeat(beat, everyMs) {
  const timer = setInterval(beat, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
