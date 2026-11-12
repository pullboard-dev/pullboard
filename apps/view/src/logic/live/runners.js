/**
 * The live snapshot's runner progress [C7,N26]: every runner numbered 1..N with what it runs now, and every running
 * gate, landing or test run with its items, files selected, done and failing so far, per-file state and an estimate
 * from recorded file timings. The read and estimate come from withdrawn #5792; its page does not.
 *
 * Why: a landing gate reran 1,579 files for 45 minutes across runners on 11 Nov and pullboard.dev/live showed none of it.
 * This file only reads its arguments, so the snapshot and its tests derive every number the same way.
 */

/** The job kinds a runner pulls from the board's queue. */
export const PULLED_KINDS = Object.freeze(['gate', 'land', 'landing', 'test']);

/** The public word for each job or lease kind; any other kind is runner work the snapshot names as null. */
const KIND_WORDS = Object.freeze({ gate: 'gate', submit: 'gate', land: 'landing', landing: 'landing', test: 'test run', 'main-red': 'test run' });

/** A runner's per-file progress words, as the snapshot says them. */
const FILE_STATES = Object.freeze({ waiting: 'waiting', queued: 'waiting', running: 'running', green: 'green', pass: 'green', passed: 'green', red: 'red', fail: 'red', failed: 'red' });

/** How many finished files the snapshot lists per run, newest first. */
const LATEST_FILES = 8;

/** The middle of the recorded file times, or null when none is recorded. */
function medianTime(fileTimes) {
  const times = Object.values(fileTimes ?? {}).filter(ms => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
  if (!times.length) return null;
  const middle = Math.floor(times.length / 2);
  return times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2;
}

/**
 * The time a run has left, from the recorded wall time of each selected file spread over the runners running it.
 * A file with no recorded time counts as the median recorded file, so one new test never hides the estimate.
 *
 * @param {{ files?: string[] | null, selected?: number | null, finished?: number | null, lanes?: number, elapsedMs: number, fileTimes: Record<string, number> }} run
 * @returns {{ totalMs: number, leftMs: number, overMs: number } | null} null when no file time is recorded or nothing was selected.
 */
export function estimateLeft({ files = null, selected = null, finished = null, lanes = 1, elapsedMs, fileTimes }) {
  const median = medianTime(fileTimes);
  const count = files?.length ?? selected;
  if (median === null || !Number.isFinite(count) || count <= 0) return null;
  const serialMs = files ? files.reduce((sum, file) => sum + (Number.isFinite(fileTimes[file]) ? fileTimes[file] : median), 0) : count * median;
  const totalMs = Math.round(serialMs / Math.max(1, lanes));
  // Finished files say more than the clock: the rest of the work is the unfinished share of the total.
  const byFiles = Number.isFinite(finished) && finished > 0 ? Math.round(totalMs * Math.max(0, count - finished) / count) : null;
  const leftMs = byFiles ?? Math.max(0, totalMs - elapsedMs);
  return { totalMs, leftMs, overMs: byFiles === null ? Math.max(0, elapsedMs - totalMs) : 0 };
}

/** A repo-relative test path, or null for anything absolute, upward or unusual that could name the machine. */
function relativeFile(file) {
  return typeof file === 'string' && /^[\w@+-][\w.@+-]*(?:\/[\w@+-][\w.@+-]*)*$/u.test(file) && !file.split('/').includes('..') ? file : null;
}

/** A whole number from a record, or null when it is not one. */
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** A positive item id from a record, or null. */
const itemId = value => /^[1-9][0-9]*$/u.test(String(value ?? '')) ? Number(value) : null;

/** The landing batch a pushed lease works for, read from its checkout path under landings/<batch>/. */
const leaseBatch = holder => /\/landings\/([0-9a-f-]{36})\//u.exec(String(holder.repo ?? ''))?.[1] ?? null;

/**
 * One run's per-file state and latest finished files from its runner's progress step: `files` maps a path to a
 * state word (or lists { file, state }), `latest` lists finished files newest first. Without them, every selected
 * file's state is null, since nothing says which ones ran.
 */
function fileProgress(files, progress) {
  const reported = new Map();
  const listed = Array.isArray(progress?.files) ? progress.files.map(entry => [entry?.file, entry?.state])
    : progress?.files && typeof progress.files === 'object' ? Object.entries(progress.files) : [];
  for (const [file, state] of listed) if (relativeFile(file) && FILE_STATES[state]) reported.set(file, FILE_STATES[state]);
  const names = files ?? (reported.size ? [...reported.keys()] : null);
  const perFile = names ? names.map(relativeFile).filter(Boolean).map(file => ({ file, state: reported.get(file) ?? (reported.size ? 'waiting' : null) })) : null;
  const latest = (Array.isArray(progress?.latest) ? progress.latest : [])
    .map(entry => typeof entry === 'string' ? { file: entry, state: reported.get(entry) ?? null } : { file: entry?.file, state: FILE_STATES[entry?.state] ?? null })
    .filter(entry => relativeFile(entry.file) && ['green', 'red', null].includes(entry.state)).slice(0, LATEST_FILES)
    .map(entry => ({ file: entry.file, state: entry.state }));
  return { perFile, latest };
}

/**
 * The anonymous public runner progress, from what readLiveRunners read. Runners are numbered 1..N: configured runners
 * in their settings order, then any other runner by its sorted name. No runner name, host, seat, agent, checkout
 * path, job id or batch id is copied out; only numbers, kind words, item ids and repo-relative test paths are.
 *
 * @param {{
 *   now: number,
 *   runners?: { host: string, unavailable?: boolean, holders?: { agent?: string, repo?: string, since: string, item?: string, kind?: string, landing?: number }[] }[],
 *   configured?: { host: string }[],
 *   jobs?: { id: string, kind: string, item: number | null, items?: number[], runner: string, claimedAt: number, files?: string[] | null, progress?: object | null }[],
 *   landings?: { batch: string, items: number[], startedAt: number, files?: string[] | null, selected?: number | null, progress?: object | null }[],
 *   fileTimes?: Record<string, number>,
 * }} sources
 * @returns {{ runners: { runner: number, state: 'busy' | 'idle', jobs: object[] }[], runs: object[] }}
 */
export function publicRunners({ now, runners = [], configured = [], jobs = [], landings = [], fileTimes = {} }) {
  if (!Number.isFinite(now)) throw new TypeError('the live runner snapshot needs an explicit clock reading');
  const order = [...new Set((Array.isArray(configured) ? configured : []).map(runner => runner?.host).filter(name => typeof name === 'string'))];
  const others = [...new Set([...runners.map(runner => runner.host), ...jobs.map(job => job.runner)])].filter(name => typeof name === 'string' && !order.includes(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const numbers = new Map([...order, ...others].map((name, index) => [name, index + 1]));
  const work = new Map([...numbers.values()].map(number => [number, []]));
  const runs = new Map();
  /** The run one lease or job belongs to, made once per key. */
  const runOf = (key, fields) => {
    if (!runs.has(key)) runs.set(key, { runners: new Set(), since: Infinity, files: null, selected: null, progress: null, ...fields });
    return runs.get(key);
  };
  for (const landing of landings) runOf(`landing:${landing.batch}`, { kind: 'landing', items: landing.items ?? [], since: landing.startedAt,
    files: landing.files ?? null, selected: count(landing.selected), progress: landing.progress ?? null });
  for (const runner of runners) {
    for (const holder of runner.holders ?? []) {
      const batch = leaseBatch(holder), item = itemId(holder.item);
      const kind = KIND_WORDS[holder.landing || batch ? 'landing' : holder.kind] ?? null;
      const key = batch ? `landing:${batch}` : item && kind ? `${kind}:${item}` : null;
      const since = Date.parse(holder.since);
      if (key) {
        const run = runOf(key, { kind, items: item ? [item] : [] });
        run.runners.add(numbers.get(runner.host));
        if (Number.isFinite(since)) run.since = Math.min(run.since, since);
      }
      work.get(numbers.get(runner.host)).push({ key, kind, item, since });
    }
  }
  for (const job of jobs) {
    const kind = KIND_WORDS[job.kind] ?? null, items = job.items?.length ? job.items : job.item ? [job.item] : [];
    const run = runOf(`job:${job.id}`, { kind, items, since: job.claimedAt, files: job.files ?? null, progress: job.progress ?? null });
    run.runners.add(numbers.get(job.runner));
    work.get(numbers.get(job.runner)).push({ key: `job:${job.id}`, kind, item: items[0] ?? null, since: job.claimedAt });
  }
  /** One run's public counts and estimate; a count the records do not hold is null. */
  const project = run => {
    const files = Array.isArray(run.files) ? run.files.filter(relativeFile) : null;
    const selected = files?.length ?? run.selected;
    const done = count(run.progress?.finished), failing = count(run.progress?.failures);
    const elapsedMs = Number.isFinite(run.since) ? Math.max(0, now - run.since) : null;
    const estimate = elapsedMs === null ? null : estimateLeft({ files, selected, finished: done, lanes: Math.max(1, run.runners.size), elapsedMs, fileTimes });
    const { perFile, latest } = fileProgress(files, run.progress);
    return { kind: run.kind, item: run.items[0] ?? null, items: [...run.items], runners: [...run.runners].filter(Boolean).sort((a, b) => a - b),
      minutesRunning: elapsedMs === null ? null : Math.floor(elapsedMs / 60_000), selected: selected ?? null, done, failing,
      minutesLeft: estimate ? Math.ceil(estimate.leftMs / 60_000) : null, files: perFile, latest };
  };
  const projected = new Map([...runs].map(([key, run]) => [key, project(run)]));
  return {
    runners: [...work].map(([runner, held]) => ({ runner, state: held.length ? 'busy' : 'idle',
      jobs: held.sort((a, b) => a.since - b.since).map(({ key, kind, item }) => {
        const run = key ? projected.get(key) : null;
        return { kind, item: run?.item ?? item, selected: run?.selected ?? null, done: run?.done ?? null, failing: run?.failing ?? null, minutesLeft: run?.minutesLeft ?? null };
      }) })),
    runs: [...runs.entries()].sort(([, a], [, b]) => a.since - b.since).map(([key]) => projected.get(key)),
  };
}
