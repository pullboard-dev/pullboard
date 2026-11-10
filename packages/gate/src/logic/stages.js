/** Start a gate's independent stages together; the gate lasts as long as its slowest stage [C7]. */

/**
 * Run every stage at once and resolve with each stage's result by name once all are green.
 * Why: stages that ran one after another made a gate take the sum of its stages; started together on
 * their own runner slots, it takes as long as the slowest. The first red stage aborts the shared signal,
 * so a stage that honors it stops, and the gate refuses with that red at once instead of waiting for the rest.
 *
 * @param {{ name: string, run: (signal: AbortSignal) => Promise<unknown> | unknown }[]} stages
 * @param {{ onStage?: (row: { name: string, ms: number, green: boolean }) => void, now?: () => number }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export function runGateStages(stages, { onStage, now = () => performance.now() } = {}) {
  const controller = new AbortController();
  const results = {};
  const started = now();
  let remaining = stages.length;
  return new Promise((resolve, reject) => {
    if (!remaining) { resolve(results); return; }
    for (const stage of stages) {
      Promise.resolve().then(() => stage.run(controller.signal)).then((value) => {
        results[stage.name] = value;
        onStage?.({ name: stage.name, ms: now() - started, green: true });
        if (--remaining === 0 && !controller.signal.aborted) resolve(results);
      }, (error) => {
        onStage?.({ name: stage.name, ms: now() - started, green: false });
        if (controller.signal.aborted) return; // A stage stopped by the first red reports nothing more.
        controller.abort(error);
        reject(error);
      });
    }
  });
}
