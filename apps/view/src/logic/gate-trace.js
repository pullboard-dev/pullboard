/** The gate trace projection: a gate job view becomes ordered phases with start, end, duration and the gaps between them, all in ms [C7]. */

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
export function phaseKind(name) {
  return KINDS.find(([, pattern]) => pattern.test(name))?.[0] ?? 'step';
}

/**
 * Turn a gate job view into its ordered phases. Pure: the page passes the plain object `jobView` returns (steps with name,
 * seq, payload and `at` in ms) and nothing here reads a clock, a file or the DOM.
 *
 * Each step is one phase that ends at its `at`. It starts at its payload `startedAt` when it carries one, otherwise at the
 * previous phase's end (the job's `created` for the first), so a step written when its work finished still shows how long
 * the work took. When a phase starts later than the one before it ended, a `gap` row holds the silence between them. Phases
 * come back in start order, then step order; a phase never starts before the job did.
 *
 * @param {{ id?: string, item?: number|null, created: number, updated?: number, steps: { name: string, seq?: number, payload?: any, at: number }[] }} job
 * @returns {{ job: string|null, item: number|null, start: number, end: number, totalMs: number, busyMs: number, gapMs: number,
 *   phases: { type: 'phase'|'gap', kind: string, name: string, shard: string|null, start: number, end: number, ms: number }[] }}
 */
export function gateTrace(job) {
  const steps = (job.steps ?? []).map((step, index) => ({ ...step, index })).filter((step) => !KEEPSAKE.test(step.name) && Number.isFinite(step.at));
  steps.sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0) || a.index - b.index);
  const origin = Number.isFinite(job.created) ? job.created : steps[0]?.at ?? 0;
  const phases = [];
  let cursor = origin;
  for (const step of steps) {
    const declared = Number(step.payload?.startedAt);
    const start = Math.min(step.at, Math.max(origin, Number.isFinite(declared) ? declared : cursor));
    if (start > cursor && phases.length) phases.push({ type: 'gap', kind: 'gap', name: 'gap', shard: null, start: cursor, end: start, ms: start - cursor });
    const shard = phaseKind(step.name) === 'shard' ? String(step.payload?.shard ?? step.name.replace(/^(shard|tests?)[:/]/u, '')) : null;
    phases.push({ type: 'phase', kind: phaseKind(step.name), name: step.name, shard, start, end: step.at, ms: step.at - start });
    cursor = Math.max(cursor, step.at);
  }
  const end = Math.max(cursor, Number.isFinite(job.updated) ? job.updated : cursor);
  const gapMs = phases.filter((phase) => phase.type === 'gap').reduce((sum, phase) => sum + phase.ms, 0);
  return { job: job.id ?? null, item: job.item ?? null, start: origin, end, totalMs: end - origin, busyMs: end - origin - gapMs, gapMs, phases };
}
