/** Choose a runner by its own live load, so no runner runs at 10x its cores while others idle [C7]. */

/** A runner whose 1-minute load average is above this many times its cores takes no new job. */
const RUNNER_OVERLOAD_FACTOR = 1.5;
/** A reading this recent ranks runners by headroom. */
const RUNNER_READING_FRESH_MS = 30_000;
/**
 * An overloaded reading keeps its runner skipped this long even after it goes stale.
 * Why: an overloaded runner is the one whose probe is likeliest to time out, and a
 * missing reading must never make it look idle again.
 */
const RUNNER_OVERLOAD_HOLD_MS = 5 * 60_000;

/** Age of a runner-reported reading in ms, or null when it is missing, malformed or future-dated. */
function readingAge(sample, now) {
  const age = now - Date.parse(sample?.at);
  return sample && Number.isFinite(age) && age >= 0 ? age : null;
}

/**
 * Describe one runner's live load from its own reading: its 1-minute load, its cores, the jobs
 * admitted since the reading (which the load average cannot show yet), and its headroom in cores.
 * @param {{cores?:number,cpuLoad?:{at:string,busyPercent:number,average:number[]}}} runner
 * @param {number} admittedSince - Jobs this pool admitted to the runner after the reading.
 * @param {number} now
 * @param {number} factor - The overload multiple of cores.
 */
function runnerLoad(runner, admittedSince, now, factor = RUNNER_OVERLOAD_FACTOR) {
  const sample = runner.cpuLoad, age = readingAge(sample, now);
  const load = sample?.average?.[0];
  if (age === null || !Number.isSafeInteger(runner.cores) || runner.cores < 1 || !Number.isFinite(load) || load < 0) {
    return { fresh: false, overloaded: false };
  }
  const effective = load + admittedSince;
  const overloaded = effective > factor * runner.cores && age <= RUNNER_OVERLOAD_HOLD_MS;
  return { fresh: age <= RUNNER_READING_FRESH_MS, overloaded, load, cores: runner.cores, headroom: runner.cores - effective, age };
}

/**
 * Pick among runners with a free compatible slot. Overloaded runners are skipped; the runner with the
 * most headroom wins; runners without a fresh reading come after every fresh one with headroom left.
 * Returns null with a reason when every free runner is overloaded, so the job queues instead of failing.
 * Readings without cores keep the earlier busy-share rule, so an unmeasured pool behaves as before.
 * @param {Array<object>} compatible - Free compatible runners in queue order.
 * @param {(host:string) => {slots:number, admittedSince:number}} usage
 * @param {{ceiling?:number, factor?:number}} policy
 * @param {number} now
 * @returns {{selected: object|null, dispatch: object}}
 */
function pickRunnerByLoad(compatible, usage, policy, now) {
  const factor = Number.isFinite(policy.factor) && policy.factor > 0 ? policy.factor : RUNNER_OVERLOAD_FACTOR;
  const ceiling = Number.isFinite(policy.ceiling) && policy.ceiling >= 1 && policy.ceiling <= 100 ? policy.ceiling : 90;
  if (!compatible.length) return { selected: null, dispatch: undefined };
  const rows = compatible.map(runner => ({ runner, shards: usage(runner.host).landingShards ?? 0, ...runnerLoad(runner, usage(runner.host).admittedSince, now, factor) }));
  const open = rows.filter(row => !row.overloaded);
  if (!open.length) {
    const named = rows.map(row => `${row.runner.host} load ${row.load.toFixed(1)} on ${row.cores} cores`).join(', ');
    return { selected: null, dispatch: { reason: `every free runner is above ${factor}x its cores (${named}); queued until one has headroom`, factor } };
  }
  const measured = open.filter(row => row.fresh);
  if (measured.length) {
    // A host already running a landing shard comes after every host running none: one load reading per minute let
    // three shards of one batch pile onto the lightest host on 6 Nov, each slowing the others [C7].
    // Lower load per core first (the criterion of #5578): a 4-core box at load 1 is busier than a 10-core box at load 2.5.
    const perCore = row => (row.cores - row.headroom) / row.cores;
    const byHeadroom = (a, b) => a.shards - b.shards || perCore(a) - perCore(b) || a.runner.cpuLoad.busyPercent - b.runner.cpuLoad.busyPercent;
    const roomy = measured.filter(row => row.headroom > 0).sort(byHeadroom);
    const tight = measured.filter(row => row.headroom <= 0).sort(byHeadroom);
    const best = roomy[0] ?? open.find(row => !row.fresh) ?? tight[0];
    const skipped = rows.filter(row => row.overloaded).map(row => row.runner.host);
    return { selected: best.runner, dispatch: best.fresh
      ? { reason: 'most headroom by runner-reported 1-minute load', load: best.load, cores: best.cores, headroom: best.headroom, factor, ...(skipped.length ? { skipped } : {}) }
      : { reason: 'no fresh reading with headroom; first runner without a reading', factor, ...(skipped.length ? { skipped } : {}) } };
  }
  return busyShareFallback(open.map(row => row.runner), usage, ceiling, now);
}

/** The earlier rule for readings without cores: lowest fresh busy share under the ceiling, else most free slots. */
function busyShareFallback(compatible, usage, ceiling, now) {
  const busy = compatible.filter(runner => {
    const age = readingAge(runner.cpuLoad, now);
    return age !== null && age <= RUNNER_READING_FRESH_MS && Number.isFinite(runner.cpuLoad.busyPercent)
      && runner.cpuLoad.busyPercent >= 0 && runner.cpuLoad.busyPercent <= 100;
  });
  const quiet = busy.filter(runner => runner.cpuLoad.busyPercent < ceiling);
  if (quiet.length) {
    const selected = [...quiet].sort((a, b) => a.cpuLoad.busyPercent - b.cpuLoad.busyPercent)[0];
    return { selected, dispatch: { reason: 'lowest recent runner-reported CPU busy share', busyPercent: selected.cpuLoad.busyPercent, ceiling } };
  }
  const selected = [...compatible].sort((a, b) => usage(a.host).slots - usage(b.host).slots)[0];
  return { selected, dispatch: { reason: busy.length === compatible.length ? 'all compatible runners at or above CPU ceiling; falling back to free slots' : 'missing or stale runner CPU readings; falling back to free slots', ceiling } };
}

/** A runner whose jobs failed for infrastructure this recently is skipped while a healthy runner is free. */
const RUNNER_TROUBLE_MS = 15 * 60_000;

/**
 * Hosts that look unhealthy from the pool's own records: a recent unavailable or cleanup-timeout
 * failure, or a lease whose heartbeat stopped. Why: a cleared quarantine can send the retry straight
 * back to the runner that just failed it, as #1519 failed twice on one runner.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} now
 * @param {number} leaseMs - Heartbeat age after which a lease is stale.
 * @returns {Set<string>}
 */
export function troubledRunners(db, now, leaseMs) {
  const since = new Date(now - RUNNER_TROUBLE_MS).toISOString();
  const failed = db.prepare("SELECT DISTINCT host FROM runner_recovery_event WHERE kind = 'unavailable' AND at >= ?").all(since).map(row => row.host);
  const stale = db.prepare("SELECT DISTINCT runner FROM holder WHERE name LIKE 'runner:%' AND runner <> '' AND beat < ?").all(now - leaseMs).map(row => row.runner);
  return new Set([...failed, ...stale]);
}

/**
 * Try runner tiers in order and take the first with headroom: healthy browser-free, healthy, then the
 * same for troubled runners. Why browser-free first: flexible work leaves browser slots for browser runs.
 * @returns {{selected: object|null, dispatch: object|undefined}}
 */
export function pickTieredRunner(compatible, troubled, browser, usage, policy, now) {
  const healthy = compatible.filter(runner => !troubled.has(runner.host));
  let pick = { selected: null, dispatch: undefined };
  for (const pool of [healthy, compatible]) {
    for (const tier of [browser ? [] : pool.filter(runner => runner.browser === 0), pool]) {
      if (!tier.length) continue;
      pick = pickRunnerByLoad(tier, usage, policy, now);
      if (pick.selected) return pool === healthy || !healthy.length ? pick : { ...pick, dispatch: { ...pick.dispatch, troubled: true } };
    }
  }
  return pick;
}
