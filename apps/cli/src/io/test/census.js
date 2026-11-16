/** `pullboard test --census`: every tracked test file in a few shards per runner, one JSONL row per file, one process [C7]. */
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Refused } from '../../../../../packages/kernel/light.js';
import { parseProcessCensus } from '../../../../../packages/kernel/index.js';
import { COLLECTION_ID_ENV } from '../../../../../packages/gate/index.js';
import { allTestOutcomes } from '../../../../../packages/gate/index.js';
import { browserBoundFiles } from '../../../../../packages/gate/index.js';
import { testsNeedGui } from '../../../../../packages/gate/index.js';
import { LANDING_COLLECT_ALL_ENV } from '../../../../../packages/landing/index.js';
import { LANDING_SHARD_ENV } from '../../../../../packages/gate/index.js';
import { formatTestOutcomes } from '../../../../../packages/gate/index.js';
import { checkoutCommonDir } from '../../../../../packages/git/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { fileKey } from '../../../../../packages/landing/index.js';
import { planLandingShards } from '../../../../../packages/landing/index.js';
import { runLandingShards } from '../../../../../packages/landing/index.js';
import { FILE_TIME_LINE } from '../../../../../packages/landing/index.js';
import { shardFileTimes } from '../../../../../packages/landing/index.js';
import { readFileTimes } from '../../../../../packages/gate/index.js';
import { writeFileTimes } from '../../../../../packages/gate/index.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { gateRunnerAdmission } from '../../../../../packages/config/index.js';
import { censusRecordFileTimesEnabled } from '../../../../../packages/config/index.js';
import { censusRerunNonGreenEnabled } from '../../../../../packages/config/index.js';
import { censusRerunOnSettleEnabled } from '../../../../../packages/config/index.js';
import { censusBalanceByTimeEnabled } from '../../../../../packages/config/index.js';
import { censusJobMinutes } from '../../../../../packages/config/index.js';
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
import { censusPlan } from '../../logic/census.js';
import { storeName } from '../store-names.js';
import { runPulledComparison } from './pull.js';
import { fileBudgetField } from './file-limit.js';
import { withFileLimit } from './file-limit.js';

/** Tracked test entry files at HEAD, the way the gate lists them for a full suite. */
async function trackedTests(root) {
  const { trackedDefaultTestFiles } = await import('../../../../../packages/gate/index.js');
  return trackedDefaultTestFiles(root, process.env).map(file => file.replace(/^\.\//u, ''));
}

/** The HEAD sha, refusing a checkout whose uncommitted changes would make the rows not about that sha. */
function cleanHead(root) {
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (git(['status', '--porcelain']).stdout.trim()) throw new Refused('CENSUS_DIRTY', 'a census reports on a commit, and this checkout has uncommitted changes', 'commit or discard them, or run the census from a clean checkout of main');
  return git(['rev-parse', 'HEAD']).stdout.trim();
}

/** The census plan, cut by measured time behind census.balanceByTime and by the landing planner otherwise; the dispatcher and the row writer both cut it here so a label names the same files [C7]. */
const cutPlan = (root, files, count, timed = true) => { const times = readFileTimes(root); return censusPlan(files, count, times, censusBalanceByTimeEnabled(), () => planLandingShards(files, count, times, root), timed ? censusJobMinutes() : null); };

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

/**
 * Rerun one non-green file alone and put rerunRow's answer in `rows`. `fileLimit: false` asks the dispatcher for the
 * usual per-file kill instead of the census's no-file-limit hard stop, so a file that hung once cannot hold the census
 * for ten minutes again [C7,#9283].
 */
async function rerunOne({ rows, sha, run, base, first, fileLimit }) {
  let pending = null, again = null;
  const write = (text) => {
    const header = parseShardHeader(text);
    if (header) { pending = header; return; }
    if (!pending || /^# landing (?:shards?|timing|floor|file|result)\b/u.test(text) || !finalStatus(pending.status)) return;
    [again] = shardRows({ ...pending, output: text, files: [first.file], outcomes: allTestOutcomes(text), times: shardFileTimes(text) }, sha);
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
    const plan = cutPlan(root, files, count), perRunner = censusJobsPerRunner();
    await Promise.all(plan.map(async (shard, index) => {
      const label = `${index + 1}/${plan.length}`, started = Date.now();
      const shell = `${LANDING_COLLECT_ALL_ENV}=1 ${LANDING_SHARD_ENV}=${word(label)} ${command.trimEnd()} ${shard.files.map(file => word(`./${file}`)).join(' ')}`;
      try {
        const ran = await runPulledComparison(ctx, { commit, main, command: shell, files: shard.files, runId: randomUUID(), ...(fileLimit === false ? {} : fileBudgetField(values)), ...(perRunner ? { censusPerRunner: perRunner } : {}) });
        write(`# landing shard ${label} attempt 1 on ${ran.runner ?? 'pulled'}: ${ran.green ? 'green' : 'red'} in ${Date.now() - started} ms\n`);
        // The receipt's tail is clipped, so each file's own time line comes from the runner's whole-output record [C7,#8576].
        const timed = pulledTimeLines(ran.times, FILE_TIME_LINE) + pulledTimeLines(ran.caseMs, FILE_CASE_LINE);
        write(`${formatTestOutcomes(randomUUID(), ran.outcomes ?? verdictOutcomes(ran.verdicts) ?? [])}${timed}${ran.output}\n`);
      } catch (error) {
        io.err(`pullboard test --census: shard ${label} got no answer: ${error?.message ?? error}`);
        write(`# landing shard ${label} attempt 1 on none: infrastructure (${error?.code ?? 'error'}) in ${Date.now() - started} ms\n`);
        write(`${error?.message ?? error}\n`);
      }
    }));
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
 * @param {{ shards?: number, prefixes?: string[], run?: typeof runLandingShards }} [options] - `shards` overrides the count the registered runners give; `prefixes` limits the census to files under them (a sample for timing); `run` replaces the shard dispatcher.
 * @returns {Promise<number>}
 */
export async function runCensus(io, ctx, values, { shards, prefixes = [], run } = {}) {
  const root = ctx.info.root;
  const sha = cleanHead(root);
  const tracked = await trackedTests(root);
  const files = tracked.filter(file => !prefixes.length || prefixes.some(prefix => file.startsWith(prefix.replace(/^\.\//u, ''))));
  if (!files.length) throw new Refused('NO_TEST_FILE', 'no tracked test files match this census', 'run the census from a repository checkout, with path prefixes that name tracked test files');
  const out = resolve(root, values.out ?? join(checkoutCommonDir(root) ?? join(root, '.git'), 'pullboard', 'census', `${storeName(sha.slice(0, 10), '.jsonl')}`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, '');
  // A pull board offers each shard as a job; the landing path's in-process controller custody is never taken (#7602).
  const pulled = !run && runnerDispatchMode() === 'pull';
  const dispatch = run ?? (pulled ? pulledCensus(ctx, io, values) : runLandingShards);
  // A settle rerun asks for the usual per-file kill, so the census's no-file-limit flag does not reach it (#9283).
  const settleReruns = censusRerunOnSettleEnabled() && dispatch !== runLandingShards;
  run = (...args) => (args[0]?.fileLimit === false ? dispatch(...args) : withFileLimit(values, () => dispatch(...args)));
  const runners = censusShardCount(loadMachineSettings().runners);
  // census.jobMinutes, when set, sizes a pulled census by measured time: the job count is whatever the plan needs (cutPlan ignores `count`).
  const timed = pulled && censusJobMinutes() ? cutPlan(root, files, 1).length : null;
  const count = Math.min(timed ?? shards ?? (pulled ? pulledShardCount(files.length, runners) : runners), files.length);
  // The same plan runLandingShards cuts, so a shard's label names the files it held.
  const plan = cutPlan(root, files, count, pulled);
  const rows = new Map();
  const last = new Map();
  const settled = [];
  const emit = (shard, record) => {
    const text = shardRows({ ...record, files: shard.files.map(file => fileKey(file)), outcomes: allTestOutcomes(record.output), times: shardFileTimes(record.output) }, sha);
    for (const row of text) {
      rows.set(row.file, row); appendFileSync(out, `${JSON.stringify(row)}\n`);
      // census.rerunOnSettle: this file's job has settled, so its rerun starts now, alongside the jobs still running; a hung file is not rerun [C7,#9283].
      if (settleReruns && rerunnable(row) && row.status !== 'hung') settled.push(rerunOne({ rows, sha, run, base, first: row, fileLimit: false }));
    }
  };
  let pending = null;
  const write = (text) => {
    const header = parseShardHeader(text);
    if (header) { pending = header; return; }
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
  const started = Date.now();
  const bound = browserBoundFiles(root, files).then(list => new Set(list));
  const base = { root, runner: resolve(root, 'apps/cli/src/io/run/tests.js'), fullScope: true, parseProcessCensus,
    runnerAdmission: gateRunnerAdmission(), needsGui: shardFiles => testsNeedGui(root, shardFiles),
    needsBrowser: async shardFiles => { const set = await bound; return shardFiles.some(file => set.has(file)); } };
  try {
    try {
      await run({ ...base, files, count: plan.length, write });
    } finally {
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
  } finally {
    if (env.collect === undefined) delete process.env[LANDING_COLLECT_ALL_ENV]; else process.env[LANDING_COLLECT_ALL_ENV] = env.collect;
    if (env.collection === undefined) delete process.env[COLLECTION_ID_ENV]; else process.env[COLLECTION_ID_ENV] = env.collection;
  }
  // Opt-in: the same record steers landing shard plans, so a census writes it only when this machine asked; files no longer tracked drop [C7].
  if (censusRecordFileTimesEnabled()) { const measured = rowFileTimes(rows.values()); if (Object.keys(measured).length) writeFileTimes(root, measured, { keep: tracked }); }
  const counts = {};
  for (const row of rows.values()) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const seconds = Math.round((Date.now() - started) / 1000);
  io.result?.({ out, sha, files: files.length, shards: plan.length, seconds, counts });
  io.say(`census of ${files.length} files at ${sha.slice(0, 10)} in ${seconds}s over ${plan.length} shards: ${Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ')}; rows in ${out}`);
  return (counts.green ?? 0) === files.length ? 0 : 1;
}
