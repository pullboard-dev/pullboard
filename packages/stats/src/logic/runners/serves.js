/** What each runner serve said about itself when it claimed: its jobs setting, cores and RAM, newest claim winning [C7,#6135]. */

/** A whole number of at least 1, or null. */
function whole(value) { return Number.isSafeInteger(value) && value >= 1 ? value : null; }

/**
 * Per-serve capacity from the `claimed` steps of the jobs read for a window.
 *
 * Why: later analysis of runner speed must know the limits in effect, so the claim carries them and this reads them back.
 *
 * @param {{steps: {name: string, at: number, payload?: any}[]}[]} jobs - from readRunnerJobs with the claimed payloads read.
 * @returns {{runner: string, claims: number, jobs: number|null, cores: number|null, ram: number|null}[]} by runner name.
 */
export function serveHosts(jobs) {
  const serves = new Map();
  const claims = jobs.flatMap(job => job.steps.filter(step => step.name === 'claimed' && typeof step.payload?.runner === 'string')).sort((a, b) => a.at - b.at);
  for (const { payload } of claims) {
    const entry = serves.get(payload.runner) ?? { runner: payload.runner, claims: 0, jobs: null, cores: null, ram: null };
    entry.claims += 1;
    for (const key of ['jobs', 'cores', 'ram']) entry[key] = whole(payload[key]) ?? entry[key];
    serves.set(payload.runner, entry);
  }
  return [...serves.values()].sort((a, b) => a.runner.localeCompare(b.runner));
}
