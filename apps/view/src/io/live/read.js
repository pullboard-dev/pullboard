/**
 * Read what the live snapshot's runner progress shows, from the records the machine already keeps [C7,N26]: the machine's runner
 * leases (controller-pushed runs), each board's job table (pulled gate, landing and test jobs), the landing worker's
 * gating record and log, and the recorded per-file timings. Every read is read-only and a missing record reads as none.
 */
import { DatabaseSync } from 'node:sqlite';
import { closeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readSync } from 'node:fs';
import { join } from 'node:path';
import { PULLED_KINDS } from '../../logic/live/runners.js';
import { publicSnapshot } from '../../logic/public.js';

// Budget: the landing worker's log grows without end; the running gate's lines are in its last megabyte.
const LOG_TAIL_BYTES = 1024 * 1024;
// Budget: the newest landing records hold every batch still gating; older ones have finished.
const LANDING_RECORDS = 40;
// Budget: a gating record older than a day is a batch that stopped without saying so, never a running gate.
const GATING_STALE_MS = 24 * 3_600_000;
// A runner that ran a job in the last day is a runner of this board, idle or not.
const RUNNER_SEEN_MS = 24 * 3_600_000;
// A registered runner whose last load reading is older than this has stopped reporting: the Dashboard reads it offline (#8060).
const HEARTBEAT_FRESH_MS = 10 * 60_000;

/** The last bytes of a file as text, or '' when it cannot be read. */
export function readTail(file, bytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A tail cut mid-line starts at the next whole line.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The controller-pushed runs: every configured runner, and each runner lease the machine's resource database holds.
 *
 * @param {string} file - The machine's resources.sqlite.
 * @param {{ host: string, cpuLoad?: { at: string, busyPercent: number, average: number[] } }[]} configured - The machine settings' runners;
 *   a runner's `cpuLoad` is its latest heartbeat, carried as its load while it is fresh.
 * @param {number} [now]
 * @returns {{ host: string, unavailable: boolean, holders: object[], load?: object }[]}
 */
export function readPushedRunners(file, configured = [], now = Date.now()) {
  const fresh = load => load && Date.parse(load.at) > now - HEARTBEAT_FRESH_MS && Date.parse(load.at) <= now + 60_000 ? { load } : {};
  const runners = new Map((Array.isArray(configured) ? configured : []).filter(runner => typeof runner?.host === 'string')
    .map(runner => [runner.host, { host: runner.host, unavailable: false, holders: [], ...fresh(runner.cpuLoad) }]));
  if (!existsSync(file)) return [...runners.values()];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    for (const holder of db.prepare("SELECT runner, agent, repo, since, item, kind, landing FROM holder WHERE runner <> '' ORDER BY since, token").all()) {
      if (!runners.has(holder.runner)) runners.set(holder.runner, { host: holder.runner, unavailable: false, holders: [] });
      runners.get(holder.runner).holders.push({ ...holder });
    }
    // Older machines keep no unavailable table; their runners read as available.
    try { for (const { host } of db.prepare('SELECT host FROM runner_unavailable').all()) if (runners.has(host)) runners.get(host).unavailable = true; } catch { /* none recorded */ }
  } catch { /* A machine with no runner tables yet runs nothing on runners. */ } finally { db?.close(); }
  return [...runners.values()];
}

/** Parse a JSON column, or null when it is not JSON. */
function parsed(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * The runners that ran this board's pulled jobs in the last day, by name without the per-session suffix: the local runner
 * that ran every gate shows on the runner card even while it holds no lease and no job is live, though a finished job clears
 * its lease owner (#7763).
 *
 * @param {import('node:sqlite').DatabaseSync} db - A board, read-only.
 * @param {number} now
 * @returns {string[]}
 */
export function readRecentJobRunners(db, now) {
  const kinds = PULLED_KINDS.map(() => '?').join(', ');
  const names = new Set(db.prepare(`SELECT DISTINCT job_lease_owner AS owner FROM job WHERE job_kind IN (${kinds}) AND job_lease_owner IS NOT NULL AND job_updated > ?`)
    .all(...PULLED_KINDS, now - RUNNER_SEEN_MS).map(row => String(row.owner).replace(/-[0-9a-f]{6}$/u, '')));
  // A finished job clears its lease owner; the runner that claimed it stays named in its claimed step.
  for (const row of db.prepare(`SELECT job_step.job_step_payload AS payload FROM job JOIN job_step ON job_step.job_step_job = job.job_id AND job_step.job_step_name = 'claimed'
    WHERE job.job_kind IN (${kinds}) AND job.job_updated > ?`).all(...PULLED_KINDS, now - RUNNER_SEEN_MS)) {
    const runner = parsed(row.payload)?.runner;
    if (typeof runner === 'string' && runner) names.add(runner.replace(/-(?:[0-9a-f]{6}|\d{4,})$/u, ''));
  }
  // The per-session suffix is a random word or the runner's process id.
  return [...names];
}

/**
 * The pulled jobs a runner holds now: a gate, landing or test row offered through the queue whose lease is live.
 * The claimed time is the claim step of the current attempt; files are the test job's named files; a job's latest
 * `progress` step, when its runner writes one, gives files finished and failing so far.
 *
 * @param {import('node:sqlite').DatabaseSync} db - A board, read-only.
 * @param {number} now
 */
export function readPulledJobs(db, now) {
  const kinds = PULLED_KINDS.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT job.job_id, job.job_kind, job.job_item, job.job_lease_owner, job.job_attempt, job.job_updated, offered.job_step_payload AS offered,
      (SELECT job_step_at FROM job_step WHERE job_step_job = job.job_id AND job_step_name = 'claimed' AND job_step_seq = job.job_attempt) AS claimed_at,
      (SELECT job_step_payload FROM job_step WHERE job_step_job = job.job_id AND job_step_name = 'progress' ORDER BY job_step_seq DESC, job_step_id DESC LIMIT 1) AS progress
    FROM job JOIN job_step AS offered ON offered.job_step_job = job.job_id AND offered.job_step_name = 'offered' AND offered.job_step_seq = 0
    WHERE job.job_kind IN (${kinds}) AND job.job_step <> 'done' AND job.job_lease_owner IS NOT NULL AND job.job_lease_until > ?
    ORDER BY job.job_created, job.job_id`).all(...PULLED_KINDS, now);
  return rows.map(row => {
    const offer = parsed(row.offered) ?? {};
    const files = offer.request?.input?.data?.files;
    const items = Array.isArray(offer.payload?.items) ? offer.payload.items.map(entry => Number(entry?.id)).filter(Number.isSafeInteger) : [];
    const progress = parsed(row.progress);
    return { id: row.job_id, kind: row.job_kind, item: row.job_item, items, runner: row.job_lease_owner, claimedAt: row.claimed_at ?? row.job_updated,
      files: Array.isArray(files) && files.every(file => typeof file === 'string') ? files : null,
      progress: progress && typeof progress === 'object' ? progress : null };
  });
}

const LOG_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) gate (\S+): (.*)$/u;
const SELECTED = /^(?:(\d+) files|the full plan) selected; running$/u;
const RERUNNING = /^reused .*?; rerunning (\d+) file\(s\) whose import closure changed since the submit: (.*)$/u;

/**
 * The gate runs a landing worker's log opened, newest last: when each started, its label, how many files it selected
 * and their names when the log lists them, and whether its "run finished" line followed.
 *
 * @param {string} text
 * @returns {{ at: number, label: string, selected: number | null, files: string[] | null, finished: boolean }[]}
 */
export function landingGateRuns(text) {
  const runs = [];
  const listed = new Map();
  for (const line of String(text).split('\n')) {
    const match = LOG_LINE.exec(line);
    if (!match) continue;
    const [, stamp, label, rest] = match, at = Date.parse(stamp);
    const rerun = RERUNNING.exec(rest);
    if (rerun) { listed.set(label, rerun[2].split(', ').filter(Boolean)); continue; }
    const selected = SELECTED.exec(rest);
    if (selected) {
      const files = listed.get(label) ?? null;
      listed.delete(label);
      runs.push({ at, label, selected: selected[1] ? Number(selected[1]) : null, files: files && files.length === Number(selected[1]) ? files : null, finished: false });
      continue;
    }
    if (/^run finished\b/u.test(rest)) { const open = runs.findLast(run => run.label === label && !run.finished); if (open) open.finished = true; }
  }
  return runs;
}

/**
 * The landings gating now: each batch whose newest record says gating, whose worker still holds its landing-run
 * lease or whose candidate holds a runner, matched to the gate its worker's log opened after that record.
 *
 * @param {import('node:sqlite').DatabaseSync} db - A board, read-only.
 * @param {{ now: number, log: string, busyBatches?: Set<string>, jobsDb?: import('node:sqlite').DatabaseSync }} options - jobsDb: the read-only runs handle that holds the landing-run leases when runs_store is on; the board when off.
 */
export function readGatingLandings(db, { now, log, busyBatches = new Set(), jobsDb = db }) {
  const owners = new Set(jobsDb.prepare("SELECT job_lease_owner FROM job WHERE job_kind = 'landing-run' AND job_lease_until > ?").all(now).map(row => row.job_lease_owner));
  const newest = new Map();
  for (const row of db.prepare("SELECT event_detail FROM event WHERE event_kind = 'landing_batch' ORDER BY event_id DESC LIMIT ?").all(LANDING_RECORDS)) {
    const batch = parsed(row.event_detail)?.batch;
    if (batch?.id && !newest.has(batch.id)) newest.set(batch.id, batch);
  }
  const runs = landingGateRuns(log);
  const landings = [];
  for (const batch of newest.values()) {
    const savedAt = Date.parse(batch.updatedAt);
    if (batch.state !== 'gating' || !Number.isFinite(savedAt) || now - savedAt > GATING_STALE_MS) continue;
    if (!owners.has(`pid-${batch.pid}`) && !busyBatches.has(batch.id)) continue;
    // The worker saves the gating record a moment before it logs the gate it opens.
    const gate = runs.findLast(run => run.at >= savedAt - 5_000);
    if (gate?.finished) continue;
    landings.push({ batch: batch.id, items: (batch.items ?? []).map(entry => Number(entry?.id)).filter(Number.isSafeInteger),
      startedAt: gate?.at ?? savedAt, label: gate?.label ?? '', files: gate?.files ?? null, selected: gate?.selected ?? null, progress: null });
  }
  return landings;
}

/**
 * The per-file wall times the last landing recorded (landing-file-times.json, as the gate's readFileTimes reads it).
 *
 * @param {string} commonDir
 * @returns {Record<string, number>}
 */
export function readFileTimes(commonDir) {
  try {
    const value = JSON.parse(readFileSync(join(commonDir, 'pullboard', 'landing-file-times.json'), 'utf8'));
    return Object.fromEntries(Object.entries(value?.files ?? {}).filter(([, ms]) => Number.isFinite(ms) && ms >= 0));
  } catch { return {}; }
}

/** The default jobs handle: the board itself holds its job rows, nothing to close. */
const boardJobs = db => ({ jobs: db, close() {} });

/**
 * Everything the page's model takes, for the given boards.
 *
 * @param {{ roots: { commonDir: string }[], now: number, resources: string, configured?: { host: string }[],
 *   openBoardReadOnly: (file: string) => import('node:sqlite').DatabaseSync, registeredOnly?: boolean, jobsFor?: (db: import('node:sqlite').DatabaseSync, boardFile: string) => { jobs: import('node:sqlite').DatabaseSync, close: () => void } }} sources - openBoardReadOnly: the store's read-only board open; jobsFor: the handle that holds the board's job rows (the board itself, or the runs file when runs_store is on, #9016);
 *   registeredOnly: list only the configured runners when any are configured, never one a job's lease owner names (#8060).
 */
export function readLiveRunners({ roots, now, resources, configured = [], openBoardReadOnly, registeredOnly = false, jobsFor = boardJobs }) {
  const runners = readPushedRunners(resources, configured, now);
  const busyBatches = new Set(runners.flatMap(runner => runner.holders.map(holder => /\/landings\/([0-9a-f-]{36})\//u.exec(String(holder.repo ?? ''))?.[1]).filter(Boolean)));
  const jobs = [], landings = [];
  let fileTimes = {};
  for (const { commonDir } of roots) {
    const file = join(commonDir, 'pullboard', 'board.sqlite');
    if (!existsSync(file)) continue;
    let db, handle;
    try {
      db = openBoardReadOnly(file);
      handle = jobsFor(db, file);
      const hasJobs = handle.jobs.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job'").get();
      if (hasJobs) {
        jobs.push(...readPulledJobs(handle.jobs, now));
        for (const host of readRecentJobRunners(handle.jobs, now)) if (!(registeredOnly && configured.length) && !runners.some(runner => runner.host === host)) runners.push({ host, unavailable: false, holders: [] });
      }
      const log = readTail(join(commonDir, 'pullboard', 'automatic-landing', 'worker.log'));
      if (hasJobs) landings.push(...readGatingLandings(db, { now, log, busyBatches, jobsDb: handle.jobs }));
      fileTimes = { ...readFileTimes(commonDir), ...fileTimes };
    } catch { /* A board that cannot be read now shows on the next read. */ } finally { handle?.close(); db?.close(); }
  }
  return { now, runners, configured, jobs, landings, fileTimes, registeredOnly };
}

/**
 * The public live snapshot's runner progress for one board, refused by the same fail-closed text blocks as the rest
 * of a public export: what /live/data.json carries as `live`.
 *
 * @param {string} commonDir - The board's git common folder.
 * @param {{ resources: string, configured?: { host: string }[], openBoardReadOnly: (file: string) => import('node:sqlite').DatabaseSync,
 *   now?: number, privateBoard?: boolean, registeredOnly?: boolean }} machine - The machine's runner lease database, settings runners and read-only board open.
 * @returns {{ runners: object[], runs: object[] }}
 */
export function publicLiveRunners(commonDir, { resources, configured = [], openBoardReadOnly, now = Date.now(), privateBoard = false, registeredOnly = false, jobsFor }) {
  const sources = readLiveRunners({ roots: [{ commonDir }], now, resources, configured, openBoardReadOnly, registeredOnly, jobsFor });
  return publicSnapshot({ live: sources }, { privateBoard }).live;
}
