/** Pure reading of a job's step log: which transition comes next and which shards are still owed [C7]. */

/** The gate job's phases in order; each names the step that ends it. */
export const PHASES = Object.freeze(['queued', 'captured', 'running', 'collected', 'verdict']);

/**
 * The phase a job is in: the furthest phase step its log holds. Shard steps sit inside `running` and never move it.
 *
 * Why: the current step is the last one written, and during `running` that is a shard step, so the phase is read
 * from which phase steps exist rather than from the last name.
 *
 * @param {{ steps: { name: string }[] }} view - A jobView.
 * @returns {'queued' | 'captured' | 'running' | 'collected' | 'verdict'}
 */
export function phaseOf(view) {
  const names = new Set(view.steps.map(step => step.name));
  for (let at = PHASES.length - 1; at > 0; at -= 1) if (names.has(PHASES[at])) return PHASES[at];
  return 'queued';
}

/**
 * The payload of the first step with this name, or null when the log has none.
 *
 * @param {{ steps: { name: string, payload: any }[] }} view
 * @param {string} name
 * @returns {any}
 */
export function stepPayload(view, name) {
  return view.steps.find(step => step.name === name)?.payload ?? null;
}

/**
 * The shards of the running plan that already have a done step, keyed by shard id with their recorded result.
 *
 * @param {{ steps: { name: string, payload: any }[] }} view
 * @returns {Map<string, { shard: string, status: number, digest: string }>}
 */
export function doneShards(view) {
  const done = new Map();
  for (const step of view.steps) if (step.name === 'shard.done') done.set(step.payload.shard, step.payload);
  return done;
}

/**
 * The plan's shards that have no done step, in plan order: the only shards a resumed driver starts or reads.
 *
 * @param {{ steps: { name: string, payload: any }[] }} view
 * @returns {{ shard: string, command: string, seq: number }[]}
 */
export function owedShards(view) {
  const plan = stepPayload(view, 'running')?.shards ?? [];
  const done = doneShards(view);
  return plan.map((shard, seq) => ({ ...shard, seq })).filter(shard => !done.has(shard.shard));
}

/**
 * The default sections a plain shard run judges into: every shard exited 0 passes the proof section, any other
 * exit fails it, and the sections this job did not run are skipped.
 *
 * Why: the runner runs the project's own command, so its exit status is the one fact every project reports.
 * Callers that run static checks, the criterion or the comparison pass their own sections.
 *
 * @param {{ shards: Record<string, { status: number }> }} collected - The collected step's payload.
 * @returns {Record<string, { outcome: string, code?: string }>}
 */
export function shardSections(collected) {
  const failed = Object.entries(collected.shards).filter(([, result]) => result.status !== 0).map(([shard]) => shard);
  const proof = failed.length ? { outcome: 'fail', code: `SHARD_FAILED ${failed.join(',')}` } : { outcome: 'pass' };
  return { static: { outcome: 'skip' }, criterion: { outcome: 'skip' }, proof, cells: { outcome: 'skip' }, comparison: { outcome: 'skip' } };
}
