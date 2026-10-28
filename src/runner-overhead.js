/** Executor phase accounting and bounded cache-tip validation without additional profiling runs [C7]. */
const PHASES = ['prepareMs', 'capacityWaitMs', 'sourceMs', 'dependenciesMs', 'commandMs', 'cleanupMs'];

/** Preserve exact cache-tip type checks while replacing one Git launch per tip with one batch. */
export function validateCacheTips(tips, output) {
  const rows = (output.endsWith('\n') ? output.slice(0, -1) : output).split('\n');
  if (!tips.length) {
    if (output) throw new Error('unexpected source cache tip inventory');
    return;
  }
  if (rows.length !== tips.length || tips.some((tip, index) => {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) commit (0|[1-9][0-9]*)$/u.exec(rows[index]);
    return !match || match[1] !== tip;
  })) throw new Error('source history cache contains a missing or non-commit tip');
}

/** Record disjoint worker intervals with its monotonic clock; nested command/test durations are not added again. */
export function startRunnerPhases(clock = () => performance.now()) {
  const values = Object.fromEntries(PHASES.map(name => [name, 0]));
  const started = clock();
  let previous = 0;
  let phase = 'prepareMs';
  let finished = null;
  /** Charge elapsed time to the preceding phase at each actual worker boundary. */
  function mark(next) {
    if (finished || !PHASES.includes(next)) throw new Error('invalid runner phase transition');
    const elapsed = Math.max(previous, Math.round(clock() - started));
    values[phase] += elapsed - previous;
    previous = elapsed;
    phase = next;
  }
  /** Freeze one exact sum after cleanup, before publishing the worker receipt. */
  function finish() {
    if (!finished) {
      mark(phase);
      finished = { version: 1, ...values, totalMs: previous };
    }
    return { ...finished };
  }
  return { mark, finish };
}

/** Reject contradictory phase arithmetic; absence from an older worker remains unmeasured. */
export function runnerPhaseFields(value) {
  if (!value || value.version !== 1 || ![...PHASES, 'totalMs'].every(name => Number.isSafeInteger(value[name]) && value[name] >= 0)
    || PHASES.reduce((sum, name) => sum + value[name], 0) !== value.totalMs) return null;
  return { version: 1, ...Object.fromEntries(PHASES.map(name => [name, value[name]])), totalMs: value.totalMs };
}

/** Print actual executor intervals separately from controller admission and transport time. */
export function runnerPhaseLine(value) {
  const phases = runnerPhaseFields(value);
  if (!phases) return '';
  return `executor: ${PHASES.map(name => `${name.slice(0, -2)} ${(phases[name] / 1000).toFixed(2)}s`).join(', ')}; total ${(phases.totalMs / 1000).toFixed(2)}s`;
}

/** Decode exact bounded cat-file frames before converting annotation bytes to UTF-8. */
export function tagObjectBodies(objects, outputBuffer) {
  const limit = 128 * 1024 * 1024;
  if (!Array.isArray(objects) || objects.length > 8_192
    || objects.some(object => typeof object !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object))
    || new Set(objects).size !== objects.length || !Buffer.isBuffer(outputBuffer) || outputBuffer.length > limit) {
    throw new Error('source tag batch is invalid or exceeds the safe transfer limit');
  }
  const bodies = new Map();
  let offset = 0;
  for (const object of objects) {
    const headerEnd = outputBuffer.indexOf(10, offset);
    if (headerEnd < offset || headerEnd - offset > 96) throw new Error('source tag batch header is incomplete');
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) tag (0|[1-9][0-9]*)$/u.exec(outputBuffer.toString('utf8', offset, headerEnd));
    if (!match || match[1] !== object) throw new Error('source tag batch contains an unexpected or non-tag object');
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > limit) throw new Error('source tag batch object exceeds the safe transfer limit');
    const start = headerEnd + 1;
    const end = start + size;
    if (end >= outputBuffer.length || outputBuffer[end] !== 10) throw new Error('source tag batch body is incomplete');
    bodies.set(object, outputBuffer.toString('utf8', start, end));
    offset = end + 1;
  }
  if (offset !== outputBuffer.length) throw new Error('source tag batch contains unexpected trailing bytes');
  return bodies;
}
