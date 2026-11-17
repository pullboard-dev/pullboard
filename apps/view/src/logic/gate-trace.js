/** The gate trace projection: a gate job view becomes ordered phases with start, end, duration and the gaps between them, all in ms [C7]. */

/**
 * The projection as one self-contained function, so the page can carry its source whole: the view serializes its page code with
 * `toString()`, and a function that reads a module-level constant would not survive that. The module exports the two functions below.
 *
 * @returns {{ phaseKind: (name: string) => string, gateTrace: (job: object, options?: { now?: number }) => object }}
 */
export function gateTraceKit() {
  /** Step names that are keepsakes, never a phase of the gate's work; the job view reader skips them the same way. */
  const KEEPSAKE = /^(artifact|note):/u;

  /** The kind a step name belongs to, so the page can colour and group phases without reading names itself. */
  const KINDS = [
    ['section', /^(section|gate)[:/]/u],
    ['dispatch', /^(runner-)?dispatch(ed)?\b/u],
    ['ready', /^ready$/iu],
    ['shard', /^(shard|tests?)[:/]/u],
    ['requeue', /^(requeue|reoffered|lapsed|released)\b/u],
  ];

  /** The phase kind of one step name; any other name is a plain `step`. */
  function phaseKind(name) {
    return KINDS.find(([, pattern]) => pattern.test(name))?.[0] ?? 'step';
  }

  /**
   * Turn a gate job view into its ordered phases. Pure: the page passes the plain object `jobView` returns (steps with name,
   * seq, payload and `at` in ms) and the clock, and nothing here reads a clock, a file or the DOM.
   *
   * A step is written when its phase begins, so each phase starts at its step's `at` and runs to the next step's `at`. A step
   * whose payload carries `endedAt` ended its work there, and the silence from then to the next step is a `gap` row. The last
   * phase of a finished job ends at the job's `updated`; the last phase of a job still running is open: it ends at `now`, so
   * its `ms` is the time elapsed in it, and `current` names it. Phases come back in start order, then step order.
   *
   * @param {{ id?: string, item?: number|null, step?: string, created?: number, updated?: number, steps: { name: string, seq?: number, payload?: any, at: number }[] }} job
   * @param {{ now?: number }} [options] - The clock for a running job; a running job given no `now` ends its open phase at its last step.
   * @returns {{ job: string|null, item: number|null, running: boolean, start: number, end: number, totalMs: number, busyMs: number, gapMs: number,
   *   current: object|null, phases: { type: 'phase'|'gap', kind: string, name: string, shard: string|null, start: number, end: number, ms: number, open: boolean }[] }}
   */
  function gateTrace(job, { now = null } = {}) {
    const steps = (job.steps ?? []).map((step, index) => ({ ...step, index })).filter((step) => !KEEPSAKE.test(step.name) && Number.isFinite(step.at));
    steps.sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0) || a.index - b.index);
    const running = steps.length > 0 && job.step !== 'done';
    const origin = steps[0]?.at ?? (Number.isFinite(job.created) ? job.created : 0);
    const lastEnd = running ? Math.max(steps.at(-1).at, Number.isFinite(now) ? now : steps.at(-1).at) : Math.max(steps.at(-1)?.at ?? origin, Number.isFinite(job.updated) ? job.updated : 0);
    const phases = [];
    steps.forEach((step, at) => {
      const next = steps[at + 1]?.at ?? lastEnd, open = running && at === steps.length - 1;
      const declared = Number(step.payload?.endedAt);
      const end = Number.isFinite(declared) ? Math.min(next, Math.max(step.at, declared)) : next;
      const kind = phaseKind(step.name);
      phases.push({ type: 'phase', kind, name: step.name, shard: kind === 'shard' ? String(step.payload?.shard ?? step.name.replace(/^(shard|tests?)[:/]/u, '')) : null, start: step.at, end, ms: end - step.at, open });
      if (end < next) phases.push({ type: 'gap', kind: 'gap', name: 'gap', shard: null, start: end, end: next, ms: next - end, open: false });
    });
    const gapMs = phases.filter((phase) => phase.type === 'gap').reduce((sum, phase) => sum + phase.ms, 0);
    return { job: job.id ?? null, item: job.item ?? null, running, start: origin, end: lastEnd, totalMs: lastEnd - origin, busyMs: lastEnd - origin - gapMs, gapMs,
      current: running ? phases.findLast((phase) => phase.type === 'phase') : null, phases };
  }
  return { phaseKind, gateTrace };
}

export const { phaseKind, gateTrace } = gateTraceKit();
