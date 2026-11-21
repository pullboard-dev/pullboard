/** `pullboard test --census`: every tracked test file in a few shards per runner, one JSONL row per file, one process [C7]. */
import { appendFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { Refused } from '../../../../../packages/kernel/light.js';
import { parseProcessCensus } from '../../../../../packages/kernel/index.js';
import { COLLECTION_ID_ENV } from '../../../../../packages/gate/heavy.js';
import { allTestOutcomes } from '../../../../../packages/gate/heavy.js';
import { browserBoundFiles } from '../../../../../packages/gate/heavy.js';
import { testsNeedGui } from '../../../../../packages/gate/heavy.js';
import { LANDING_COLLECT_ALL_ENV } from '../../../../../packages/landing/index.js';
import { LANDING_SHARD_ENV } from '../../../../../packages/gate/heavy.js';
import { formatTestOutcomes } from '../../../../../packages/gate/heavy.js';
import { checkoutCommonDir } from '../../../../../packages/git/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { fileKey } from '../../../../../packages/landing/index.js';
import { runLandingShards } from '../../../../../packages/landing/index.js';
import { FILE_TIME_LINE } from '../../../../../packages/landing/index.js';
import { shardFileTimes } from '../../../../../packages/landing/index.js';
import { readFileTimes } from '../../../../../packages/gate/heavy.js';
import { writeFileTimes } from '../../../../../packages/gate/heavy.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { gateRunnerAdmission } from '../../../../../packages/config/index.js';
import { censusRecordFileTimesEnabled } from '../../../../../packages/config/index.js';
import { censusRerunNonGreenEnabled } from '../../../../../packages/config/index.js';
import { censusRerunOnSettleEnabled } from '../../../../../packages/config/index.js';
import { censusSkipUnchangedEnabled } from '../../../../../packages/config/index.js';
import { censusFileKillSeconds } from '../../../../../packages/config/index.js';
import { censusSoloFileSeconds } from '../../../../../packages/config/index.js';
import { censusJobMinutes } from '../../../../../packages/config/index.js';
import { censusSelfTuneEnabled } from '../../../../../packages/config/index.js';
import { censusJobsPerRunnerQuiet } from '../../../../../packages/config/index.js';
import { censusJobsPerRunner } from '../../../../../packages/config/index.js';
import { censusShardCount } from '../../logic/census.js';
import { pulledShardCount } from '../../logic/census.js';
import { finalStatus } from '../../logic/census.js';
import { parseShardHeader } from '../../logic/census.js';
import { shardRows } from '../../logic/census.js';
import { FILE_CASE_LINE } from '../../logic/census.js';
import { verdictOutcomes } from '../../logic/census.js';
import { pulledTimeLines } from '../../logic/census.js';
import { rowFileTimes } from '../../logic/census.js';
import { rerunRow } from '../../logic/census.js';
import { rerunnable } from '../../logic/census.js';
import { censusVerdictLists } from '../../logic/census.js';
import { censusIdleSlots } from '../../logic/census.js';
import { censusIdleLine } from '../../logic/census.js';
import { censusPhases } from '../../logic/census.js';
import { censusPhaseLine } from '../../logic/census.js';
import { censusPlan } from '../../logic/census.js';
import { rowPackedJobs } from '../../logic/census.js';
import { shardFileKillMs } from '../../logic/census.js';
import { previousShardMs } from '../../logic/census.js';
import { selfTunedJobMinutes } from '../../logic/census-tune.js';
import { storeName } from '../store-names.js';
import { runPulledComparison } from './pull.js';
import { endJob } from '../../../../../packages/jobs/index.js';
import { censusCarry } from './census-carry.js';
import { fileBudgetField } from './file-limit.js';
import { withFileLimit } from './file-limit.js';
import { withBoard } from '../context.js';

/** Tracked test entry files at HEAD, the way the gate lists them for a full suite. */
async function trackedTests(root) {
  const { trackedDefaultTestFiles } = await import('../../../../../packages/gate/heavy.js');
  return trackedDefaultTestFiles(root, process.env).map(file => file.replace(/^\.\//u, ''));
}

/** The HEAD sha, refusing a checkout whose uncommitted changes would make the rows not about that sha. */
function cleanHead(root) {
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (git(['status', '--porcelain']).stdout.trim()) throw new Refused('CENSUS_DIRTY', 'a census reports on a commit, and this checkout has uncommitted changes', 'commit or discard them, or run the census from a clean checkout of main');
  return git(['rev-parse', 'HEAD']).stdout.trim();
}

/** The census plan, cut by each file's measured seconds (the previous census's rows, then the recorded time) unless census.jobMinutes decides; the dispatcher and the row writer both cut it here so a label names the same files [C7]. */
const cutPlan = (root, files, count, timed = true) => { const times = readFileTimes(root); return censusPlan(files, count, times, false, (list = files) => rowPackedJobs(list, count, PRIOR.get(root) ?? [], times), timed ? jobMinutesFor(root) : null, censusSoloFileSeconds()); };

/** The rows of the newest earlier census for each checkout, read before this run empties its own file [C7]. */
const PRIOR = new Map();
/** The job length a self-tuning census chose for each checkout, so the dispatcher and the row writer cut the same plan [C7,U151]. */
const TUNED = new Map();
const jobMinutesFor = root => censusJobMinutes() ?? TUNED.get(root) ?? null;

/**
 * The rows of the newest earlier census in `dir` (never `out`), or null when there is none.
 *
 * @param {string} dir - The folder holding census JSONL files.
 * @param {string} out - This census's own file, never read as the earlier one.
 * @returns {object[] | null}
 */
export function earlierCensusRows(dir, out) {
  let names;
  try { names = readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name)).filter(path => resolve(path) !== resolve(out)); } catch { return null; }
  const newest = names.map(path => { try { return { path, at: statSync(path).mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.at - a.at)[0];
  if (!newest) return null;
  const rows = [];
  try { for (const line of readFileSync(newest.path, 'utf8').split('\n')) { if (line) { try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped */ } } } } catch { return null; }
  return rows;
}

/**
 * The job length, in minutes, a pulled census cuts by: the typed census.jobMinutes when set, else with census.selfTune on the
 * self-tuned length of the newest earlier census in `dir` (never `out`), else null for today's cut by file count.
 * Why: a typed number is the person's word, and a census with no earlier record has nothing to learn from [C7,U151].
 *
 * @param {string} dir - The folder holding census JSONL files.
 * @param {string} out - This census's own file, never read as the earlier one.
 * @param {{ selfTune?: boolean, typed?: number | null }} [settings]
 * @returns {number | null}
 */
export function censusJobMinutesFrom(dir, out, { selfTune = censusSelfTuneEnabled(), typed = censusJobMinutes() } = {}) {
  if (typed) return typed;
  if (!selfTune) return null;
  const rows = earlierCensusRows(dir, out);
  if (!rows) return null;
  return selfTunedJobMinutes(previousShardMs(rows));
}

/**
 * Rerun each non-green census row's file once, alone, through the census's own dispatcher, and replace its row with
 * rerunRow's answer; the JSONL is rewritten once with one row per file. A pulled census offers the reruns together as
 * one-file jobs; any other dispatcher runs them one at a time [C7,#9138].
 */
async function rerunNonGreen({ rows, out, sha, run, base, pulled }) {
  const firsts = [...rows.values()].filter(rerunnable);
  if (pulled) await Promise.all(firsts.map(first => rerunOne({ rows, sha, run, base, first })));
  else for (const first of firsts) await rerunOne({ rows, sha, run, base, first });
  writeFileSync(out, [...rows.values()].map(row => `${JSON.stringify(row)}\n`).join(''));
}

/** A write that is only a pulled job's `# census-times` line. */
const CENSUS_TIMES_WRITE = /^# census-times \{.*\}\n?$/u;

/**
 * The job times a shard's log carries (a pulled job writes them as a `# census-times` line), else the local ones: the
 * census start for claim and start, now for the end, and the load when the census began. Why: the rows could not place
 * the gap between 14 busy slots and 36 allowed, because they held no times (census 6) [C7,#9284].
 *
 * @param {string} output - The shard's log text.
 * @param {Date} fallbackStart - When this census began.
 * @param {number} fallbackLoad - The 1-minute load when it began.
 * @returns {{ enqueuedAt: string, claimedAt: string, startedAt: string, endedAt: string, load1: number }}
 */
function jobTimes(output, fallbackStart, fallbackLoad) {
  let told = {};
  const line = /^# census-times (\{.*\})$/mu.exec(String(output));
  if (line) { try { told = JSON.parse(line[1]); } catch { /* a garbled line falls back to the local times */ } }
  const iso = value => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);
  const now = new Date().toISOString(), began = fallbackStart.toISOString();
  const startedAt = iso(told.startedAt) ?? iso(told.claimedAt) ?? began;
  return { enqueuedAt: iso(told.enqueuedAt) ?? began, claimedAt: iso(told.claimedAt) ?? startedAt, startedAt, endedAt: iso(told.endedAt) ?? now, load1: Number.isFinite(told.load1) ? told.load1 : Math.round(fallbackLoad * 100) / 100 };
}

/**
 * Rerun one non-green file alone and put rerunRow's answer in `rows`. `fileLimit: false` asks the dispatcher for the
 * usual per-file kill instead of the census's no-file-limit hard stop, so a file that hung once cannot hold the census
 * for ten minutes again [C7,#9283].
 */
async function rerunOne({ rows, sha, run, base, first, fileLimit }) {
  let pending = null, again = null, told = '';
  const began = new Date(), beganLoad = loadavg()[0];
  const write = (full) => {
    const header = parseShardHeader(full);
    if (header) { pending = header; told = ''; return; }
    // A pulled job's `# census-times` line arrives as its own write before the body; keep it for the body's rows [C7,#9404].
    if (pending && CENSUS_TIMES_WRITE.test(full)) { told = full; return; }
    const text = told + full;
    if (!pending || /^# landing (?:shards?|timing|floor|file|result)\b/u.test(text) || !finalStatus(pending.status)) return;
    [again] = shardRows({ ...pending, output: text, files: [first.file], outcomes: allTestOutcomes(text), times: shardFileTimes(text) }, sha);
    if (again) again = { ...again, ...jobTimes(text, began, beganLoad) };
    pending = null;
  };
  try { await run({ ...base, files: [first.file], count: 1, write, ...(fileLimit === false ? { fileLimit } : {}) }); } catch { /* a rerun with no answer leaves the file unrun */ }
  rows.set(first.file, rerunRow(first, again ?? { file: first.file, status: 'unrun', cases: [], setupSecs: null, secs: null, sha, shard: '1/1', host: 'none' }));
}

/** Quote one shell word for a pulled job's command. */
const word = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * A shard dispatcher for a pull board: each shard is one pulled test job a runner takes, as `pullboard test` offers one,
 * and its answer is written in the landing log's words. Why: the landing path holds controller custody in this
 * process, which crashed every census on a pull board with "controller custody needs the exact process start" (#7602) [C7].
 * A shard whose job refuses is that shard's infrastructure answer, so its files are unrun and the census goes on.
 *
 * @param {object} ctx
 * @param {{ err: (line: string) => void }} io
 */
function pulledCensus(ctx, io, values = {}) {
  return async ({ root, files, count, write, fileLimit }) => {
    const command = ctx.config?.affectedTests;
    if (typeof command !== 'string' || !command.trim()) throw new Refused('NO_TEST_RUNNER', 'a pulled census runs each shard with "affectedTests" from pullboard.json, and it is unset', 'set "affectedTests" to the command that runs named test files, then run the census again');
    const { mainPolicy } = await import('../../../../../packages/sandbox/index.js');
    const commit = headCommit(root), main = mainPolicy(root).commit ?? commit;
    const plan = cutPlan(root, files, count), killSeconds = censusFileKillSeconds(), times = killSeconds ? readFileTimes(root) : {}, perRunner = censusJobsPerRunner(), quiet = censusJobsPerRunnerQuiet();
    const stopped = new AbortController(), active = new Map();
    const stopJob = (job, runs) => runs ? endJob(runs.db, job, 'withdrawn', { detail: 'census controller received SIGTERM' }) : withBoard(ctx, board => endJob(board.db, job, 'withdrawn', { detail: 'census controller received SIGTERM' }));
    const onTerm = () => {
      stopped.abort(new Error('census controller received SIGTERM'));
      // The ids are captured as each offer succeeds, so termination can end this run only.
      for (const [job, runs] of active) stopJob(job, runs);
    };
    process.once('SIGTERM', onTerm);
    try { await Promise.all(plan.map(async (shard, index) => {
      const label = `${index + 1}/${plan.length}`, started = Date.now();
      const shell = `${LANDING_COLLECT_ALL_ENV}=1 ${LANDING_SHARD_ENV}=${word(label)} ${command.trimEnd()} ${shard.files.map(file => word(`./${file}`)).join(' ')}`;
      try {
        const ran = await runPulledComparison(ctx, { commit, main, command: shell, files: shard.files, runId: randomUUID(), signal: stopped.signal,
          onOffer: (job, runs, done = false) => { if (done) active.delete(job); else { active.set(job, runs); if (stopped.signal.aborted) stopJob(job, runs); } },
          ...(fileLimit === false ? {} : { ...fileBudgetField(values), ...(shardFileKillMs(shard.files, times, killSeconds) ? { fileBudgetMs: shardFileKillMs(shard.files, times, killSeconds) } : {}) }), ...(perRunner ? { censusPerRunner: perRunner } : {}), ...(perRunner && quiet ? { censusPerRunnerQuiet: quiet } : {}) });
        write(`# landing shard ${label} attempt 1 on ${ran.runner ?? 'pulled'}: ${ran.green ? 'green' : 'red'} in ${Date.now() - started} ms\n`);
        // The receipt's tail is clipped, so each file's own time line comes from the runner's whole-output record [C7,#8576].
        write(`# census-times ${JSON.stringify({ enqueuedAt: ran.enqueuedAt, claimedAt: ran.claimedAt, startedAt: ran.startedAt, endedAt: ran.endedAt, load1: ran.loadAtStart })}\n`);
        const timed = pulledTimeLines(ran.times, FILE_TIME_LINE) + pulledTimeLines(ran.caseMs, FILE_CASE_LINE);
        write(`${formatTestOutcomes(randomUUID(), ran.outcomes ?? verdictOutcomes(ran.verdicts) ?? [])}${timed}${ran.output}\n`);
      } catch (error) {
        io.err(`pullboard test --census: shard ${label} got no answer: ${error?.message ?? error}`);
        write(`# landing shard ${label} attempt 1 on none: infrastructure (${error?.code ?? 'error'}) in ${Date.now() - started} ms\n`);
        write(`${error?.message ?? error}\n`);
      }
    }));
    } finally { process.removeListener('SIGTERM', onTerm); }
    write('# landing result: done\n');
    return { isGreen: true };
  };
}

/**
 * Run the census here, the one coordinator process for the whole run, and append a row per file to the JSONL as each
 * shard settles. Returns 0 when every file is green.
 *
 * @param {object} io
 * @param {{ info: { root: string } }} ctx
 * @param {{ out?: string, json?: boolean, 'no-file-limit'?: boolean }} values
 * @param {{ shards?: number, prefixes?: string[], run?: typeof runLandingShards, clock?: () => number }} [options] - `clock` reads the time in milliseconds for the phase seconds; `shards` overrides the count the registered runners give; `prefixes` limits the census to files under them (a sample for timing); `run` replaces the shard dispatcher.
 * @returns {Promise<number>}
 */
export async function runCensus(io, ctx, values, { shards, prefixes = [], run, clock = Date.now } = {}) {
  const root = ctx.info.root;
  const sha = cleanHead(root);
  const tracked = await trackedTests(root);
  const everyFile = tracked.filter(file => !prefixes.length || prefixes.some(prefix => file.startsWith(prefix.replace(/^\.\//u, ''))));
  if (!everyFile.length) throw new Refused('NO_TEST_FILE', 'no tracked test files match this census', 'run the census from a repository checkout, with path prefixes that name tracked test files');
  const out = resolve(root, values.out ?? join(checkoutCommonDir(root) ?? join(root, '.git'), 'pullboard', 'census', `${storeName(sha.slice(0, 10), '.jsonl')}`));
  mkdirSync(dirname(out), { recursive: true });
  // Read the earlier census before this run empties its own file.
  const tuned = censusJobMinutesFrom(join(checkoutCommonDir(root) ?? join(root, '.git'), 'pullboard', 'census'), out);
  if (tuned) TUNED.set(root, tuned); else TUNED.delete(root);
  PRIOR.set(root, earlierCensusRows(join(checkoutCommonDir(root) ?? join(root, '.git'), 'pullboard', 'census'), out) ?? []);
  // Opt-in: files whose declared inputs did not change since a green earlier census keep that row, marked carried [C7,#10383].
  const carry = censusSkipUnchangedEnabled() ? censusCarry(root, { files: everyFile, sha, dir: join(checkoutCommonDir(root) ?? join(root, '.git'), 'pullboard', 'census'), out }) : { run: everyFile, carried: [], from: null };
  const files = carry.run;
  writeFileSync(out, carry.carried.map(row => `${JSON.stringify(row)}\n`).join(''));
  // A pull board offers each shard as a job; the landing path's in-process controller custody is never taken (#7602).
  const pulled = !run && runnerDispatchMode() === 'pull';
  const dispatch = run ?? (pulled ? pulledCensus(ctx, io, values) : runLandingShards);
  // A settle rerun asks for the usual per-file kill, so the census's no-file-limit flag does not reach it (#9283).
  const settleReruns = censusRerunOnSettleEnabled() && dispatch !== runLandingShards;
  run = (...args) => (args[0]?.fileLimit === false ? dispatch(...args) : withFileLimit(values, () => dispatch(...args)));
  const runners = censusShardCount(loadMachineSettings().runners);
  // census.jobMinutes, when set, sizes a pulled census by measured time: the job count is whatever the plan needs (cutPlan ignores `count`).
  const timed = pulled && jobMinutesFor(root) ? cutPlan(root, files, 1).length : null;
  const count = Math.max(1, Math.min(timed ?? shards ?? (pulled ? pulledShardCount(files.length, runners) : runners), files.length));
  // The same plan runLandingShards cuts, so a shard's label names the files it held.
  const plan = cutPlan(root, files, count, pulled);
  const rows = new Map(carry.carried.map(row => [row.file, row]));
  const last = new Map();
  const settled = [];
  const censusStart = new Date(), startLoad = loadavg()[0];
  const marks = { start: clock(), first: null, pass1: 0 };
  const emit = (shard, record) => {
    marks.first ??= clock();
    const text = shardRows({ ...record, files: shard.files.map(file => fileKey(file)), outcomes: allTestOutcomes(record.output), times: shardFileTimes(record.output) }, sha);
    const told = jobTimes(record.output, censusStart, startLoad);
    for (const row0 of text) {
      const row = { ...row0, ...told };
      rows.set(row.file, row); appendFileSync(out, `${JSON.stringify(row)}\n`);
      // census.rerunOnSettle: this file's job has settled, so its rerun starts now, alongside the jobs still running; a hung file is not rerun [C7,#9283].
      if (settleReruns && rerunnable(row) && row.status !== 'hung') settled.push(rerunOne({ rows, sha, run, base, first: row, fileLimit: false }));
    }
  };
  let pending = null, told = '';
  const write = (full) => {
    const header = parseShardHeader(full);
    if (header) { pending = header; told = ''; return; }
    // A pulled job's `# census-times` line arrives as its own write before the body; keep it for the body's rows [C7,#9404].
    if (pending && CENSUS_TIMES_WRITE.test(full)) { told = full; return; }
    const text = told + full;
    if (!pending || /^# landing (?:shards?|timing|floor|file|result)\b/u.test(text)) return;
    const shard = plan[Number(pending.label.split('/')[0]) - 1];
    last.set(pending.label, { ...pending, output: text });
    if (shard && finalStatus(pending.status)) emit(shard, { ...pending, output: text });
    pending = null;
  };
  const env = { id: randomUUID(), collect: process.env[LANDING_COLLECT_ALL_ENV], collection: process.env[COLLECTION_ID_ENV] };
  process.env[LANDING_COLLECT_ALL_ENV] = '1';
  process.env[COLLECTION_ID_ENV] = env.id;
  io.err(`pullboard test --census: ${files.length} files at ${sha.slice(0, 10)} in ${plan.length} shards; rows go to ${out}`);
  const bound = browserBoundFiles(root, files).then(list => new Set(list));
  const base = { root, runner: resolve(root, 'apps/cli/src/io/run/tests.js'), fullScope: true, parseProcessCensus,
    runnerAdmission: gateRunnerAdmission(), needsGui: shardFiles => testsNeedGui(root, shardFiles),
    needsBrowser: async shardFiles => { const set = await bound; return shardFiles.some(file => set.has(file)); } };
  try {
    try {
      if (files.length) await run({ ...base, files, count: plan.length, write });
    } finally {
      marks.pass1 = clock();
      // A shard that never reached a last word still owes its files a row.
      for (const shard of plan.entries()) {
        const [index, entry] = shard;
        const label = `${index + 1}/${plan.length}`;
        if (entry.files.every(file => rows.has(fileKey(file)))) continue;
        emit(entry, { label, host: last.get(label)?.host ?? 'none', status: 'unrun', output: '' });
      }
    }
    await Promise.all(settled);
    // Opt-in: each non-green file runs once more, alone, before the census calls it red; this replaces a separate pass 2 [C7,#9138].
    if (settleReruns) writeFileSync(out, [...rows.values()].map(row => `${JSON.stringify(row)}\n`).join(''));
    else if (censusRerunNonGreenEnabled()) await rerunNonGreen({ rows, out, sha, run, base, pulled });
    // With reruns on the rows are the confirmed verdict, so the census writes the reds and slow lists pass 2 used to [C7,#10348].
    if (settleReruns || censusRerunNonGreenEnabled()) { const lists = censusVerdictLists(rows.values()); writeFileSync(`${out}.reds.txt`, lists.reds); writeFileSync(`${out}.slow.txt`, lists.slow); }
  } finally {
    if (env.collect === undefined) delete process.env[LANDING_COLLECT_ALL_ENV]; else process.env[LANDING_COLLECT_ALL_ENV] = env.collect;
    if (env.collection === undefined) delete process.env[COLLECTION_ID_ENV]; else process.env[COLLECTION_ID_ENV] = env.collection;
  }
  // Opt-in: the same record steers landing shard plans, so a census writes it only when this machine asked; files no longer tracked drop [C7].
  if (censusRecordFileTimesEnabled()) { const measured = rowFileTimes([...rows.values()].filter(row => !row.carried)); if (Object.keys(measured).length) writeFileTimes(root, measured, { keep: tracked }); }
  const counts = {};
  for (const row of rows.values()) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const phases = censusPhases({ ...marks, end: clock() }), seconds = phases.wallSecs;
  const idleSlots = censusIdleSlots(rows.values(), censusStart.getTime());
  io.result?.({ out, sha, files: everyFile.length, carried: carry.carried.length, shards: plan.length, seconds, phases, idleSlots, counts });
  io.say(`census of ${everyFile.length} files${carry.carried.length ? ` (${carry.carried.length} carried from ${carry.from.slice(0, 10)})` : ''} at ${sha.slice(0, 10)} in ${seconds}s over ${plan.length} shards: ${Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ')}; rows in ${out}`);
  io.say(censusPhaseLine(phases));
  const idleLine = censusIdleLine(idleSlots);
  if (idleLine) io.say(idleLine);
  return (counts.green ?? 0) === everyFile.length ? 0 : 1;
}
