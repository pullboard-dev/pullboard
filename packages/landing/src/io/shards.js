import { RERUNNABLE_RUNNER_REFUSALS } from '../../../store/index.js';
import { runnerExecutionServices } from '../../../runners/index.js';
import { constrainedLandingHost } from './host.js';
import { captureReleaseQueue } from './queue.js';
import { RELEASE_EXECUTORS_ENV } from '../../../gate/index.js';
import { RELEASE_PARTICIPATION_PREFIX } from '../../../gate/index.js';
import { fileTimesPath } from '../../../gate/index.js';
import { readFileTimes } from '../../../gate/index.js';
/**
 * The landing gate in shards [C7,V4]: split the tracked test files into balanced shards, run each on
 * a free local gate slot or a registered runner, and report one result. One red shard stops the rest,
 * and a shard whose runner fails mid-run reruns locally only when runner-only policy is off.
 */
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  gitChildEnv,
  repoInfo,
} from '../../../git/index.js';
import { testsNeedGui } from '../../../gate/index.js';
import { loadMachineSettings } from '../../../config/index.js';
import { gateRunnerAdmission } from '../../../config/index.js';
import { localRunnerDescriptor } from '../../../runners/index.js';
import { guiSession } from '../../../gate/index.js';
import { headTree } from '../../../git/index.js';
import { cpuRunnerRequired } from '../../../gate/index.js';
import { shardSelectionMatched } from '../../../gate/index.js';
import {
  BROWSER_SLOT_HELD_ENV,
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
  gateSlotEnvironment,
} from '../../../resources/index.js';

/** Exact opt-in for retaining every test failure while preserving safety cancellation. */
export const LANDING_COLLECT_ALL_ENV = 'PULLBOARD_LANDING_COLLECT_ALL';
import {
  COLLECTION_ID_ENV,
  formatCollectionReport,
  parseCollectionReports,
} from '../../../gate/index.js';

/** Environment variable naming the shard a nested run-tests process runs, as `<i>/<n>`. */
export const LANDING_SHARD_ENV = 'PULLBOARD_LANDING_SHARD';
/** Environment variable naming the file where each test file process appends its wall time. */
export const LANDING_FILE_TIMES_ENV = 'PULLBOARD_LANDING_FILE_TIMES';
/** Prefix of the per-file wall-time lines a shard prints for its orchestrator. */
export const FILE_TIME_LINE = '# landing-file-ms ';
/** Snapshot actual registered capacity without registering hosts or changing machine settings. */
export function releaseExecutors(settings = loadMachineSettings()) {
  const local = localRunnerDescriptor(settings.gateSlots, settings.browserSlots > 0, guiSession());
  const executors = [{ id: local.id, kind: 'local', browser: settings.browserSlots > 0, gui: local.capabilities.gui === true },
    ...(settings.runners ?? []).map(runner => ({ id: runner.host, kind: 'ssh', host: runner.host,
      browser: runner.browser > 0, gui: runner.gui === true }))];
  if (executors.length < 1 || executors.length > 64 || new Set(executors.map(entry => entry.id)).size !== executors.length) {
    throw new Error(`a release requires a nonempty registry of distinct executors; observed ${executors.length}`);
  }
  return executors;
}

/** Read only the producer's bounded placement request and bind it to the current native registry. */
export function releasePlacement(value, actual = releaseExecutors()) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 64 * 1024) throw new Error('invalid release executor request');
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('invalid release executor request'); }
  if (!parsed || parsed.version !== 1 || !/^[a-f0-9-]{36}$/u.test(parsed.id ?? '')
    || JSON.stringify(parsed.executors) !== JSON.stringify(actual)) {
    throw new Error('release executors changed or are incomplete; capture the native registry again');
  }
  return parsed;
}

/** Partition every file once, reserving compatible work for each executor before balancing the rest. */
export async function planReleaseShards(files, executors, times = {}, needsBrowser = async () => true, needsGui = async () => true, needsCpuRunner = async () => false) {
  if (!files.length || new Set(files.map(file => fileKey(file))).size !== files.length || executors.length < 1 || files.length < executors.length) {
    throw new Error('a release needs distinct tracked files and nonempty work for every executor');
  }
  const known = files.map(file => times[fileKey(file)]).filter(ms => Number.isFinite(ms) && ms >= 0);
  const average = known.length ? known.reduce((sum, ms) => sum + ms, 0) / known.length : 1;
  const rows = await Promise.all(files.map(async file => ({ file,
    weight: Number.isFinite(times[fileKey(file)]) && times[fileKey(file)] >= 0 ? times[fileKey(file)] : average,
    browser: await needsBrowser([file]), gui: await needsGui([file]), cpuRunner: await needsCpuRunner([file]) })));
  rows.sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  const shards = executors.map(executor => ({ executor, files: [], weight: 0 }));
  /** A placement restriction never confers browser or GUI capability on a worker. */
  const compatible = (row, shard) => (!row.browser || shard.executor.browser) && (!row.gui || shard.executor.gui)
    && (!row.cpuRunner || shard.executor.kind === 'ssh');
  const leastCapableFirst = [...shards].sort((a, b) => Number(a.executor.gui) - Number(b.executor.gui)
    || Number(a.executor.browser) - Number(b.executor.browser) || a.executor.id.localeCompare(b.executor.id));
  for (const shard of leastCapableFirst) {
    const index = rows.findIndex(row => compatible(row, shard));
    if (index < 0) throw new Error(`no compatible test work for required executor ${shard.executor.id}`);
    const [row] = rows.splice(index, 1);
    shard.files.push(row.file); shard.weight += row.weight;
  }
  for (const row of rows) {
    const shard = shards.filter(entry => compatible(row, entry)).sort((a, b) => a.weight - b.weight
      || a.files.length - b.files.length || a.executor.id.localeCompare(b.executor.id))[0];
    if (!shard) throw new Error(`no registered release executor has the capabilities required by ${row.file}`);
    shard.files.push(row.file); shard.weight += row.weight;
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

const GATE_MARKERS = [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV];
// Budget: a stopped shard's run-tests drains its owned processes within its 12 s custody limit; past
// this its group is killed.
const STOP_GRACE_MS = 20_000;
// Budget: each signal round of the final sweep waits this long for a process to go.
const SWEEP_WAIT_MS = 1_000;

/** Keep the newest wall time for every file this landing measured, beside the older ones. */
function writeFileTimes(root, measured) {
  const path = fileTimesPath(root);
  const files = { ...readFileTimes(root), ...measured };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Canonicalize a test file path to its repository-relative form: `./`, `..` and doubled slashes
 * fold away, and an absolute path under `root` becomes relative to it. Two spellings of one file
 * then share one key, so the shard planner never runs the same cases twice (#3158).
 */
export function fileKey(file, root = null) {
  const text = String(file).split(sep).join('/');
  if (!text) return '';
  const inside = root && isAbsolute(text) ? relative(root, text).split(sep).join('/') : text;
  return posix.normalize(inside).replace(/^\.\//u, '');
}

/**
 * Split files into at most `count` shards by weight, heaviest first onto the lightest shard.
 * A file with a known wall time weighs that time; with no times at all every file weighs one, so the
 * split falls back to file count. A new file weighs the average known time. Empty shards are dropped.
 *
 * @param {string[]} files
 * @param {number} count
 * @param {Record<string, number>} [times] - Last wall time in ms by repository-relative path.
 * @param {string|null} [root] - Repository root, so absolute spellings dedupe with relative ones.
 * @returns {{ files: string[], weight: number }[]}
 */
export function planLandingShards(files, count, times = {}, root = null) {
  const known = files.map(file => times[fileKey(file, root)]).filter(ms => Number.isFinite(ms));
  const average = known.length ? known.reduce((sum, ms) => sum + ms, 0) / known.length : 1;
  const weight = file => known.length ? (Number.isFinite(times[fileKey(file, root)]) ? times[fileKey(file, root)] : average) : 1;
  const distinct = new Map();
  for (const file of files) if (!distinct.has(fileKey(file, root))) distinct.set(fileKey(file, root), file); // One file once, however spelled, so no case runs twice (#3158).
  const ordered = [...distinct.values()].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const shards = Array.from({ length: Math.max(1, count) }, () => ({ files: [], weight: 0 }));
  for (const file of ordered) {
    const lightest = shards.reduce((best, shard) => shard.weight < best.weight
      || (shard.weight === best.weight && shard.files.length < best.files.length) ? shard : best);
    lightest.files.push(file);
    lightest.weight += weight(file);
  }
  for (const shard of shards) shard.files.sort((a, b) => a.localeCompare(b));
  return shards.filter(shard => shard.files.length);
}

/**
 * Split a build, submit or review run's test files across the runner slots that are free right now: at most one shard per
 * free slot and per distinct file, balanced by recorded file times through the landing planner. One free slot, or none,
 * gives one shard holding every file, so such a run executes as it does today (#3228).
 *
 * @param {string[]} files
 * @param {number} freeSlots - Runner slots the caller found free; fractions and negatives count as none.
 * @param {Record<string, number>} [times] - Last wall time in ms by repository-relative path.
 * @param {string|null} [root] - Repository root, so absolute spellings dedupe with relative ones.
 * @returns {{ shards: { files: string[], weight: number }[], balance: 'history'|'history and average'|'file count', slots: number }}
 */
export function planFreeSlotShards(files, freeSlots, times = {}, root = null) {
  const distinct = new Set(files.map(file => fileKey(file, root))).size;
  const slots = Math.max(1, Math.min(Number.isFinite(freeSlots) ? Math.floor(freeSlots) : 1, distinct));
  const shards = planLandingShards(files, slots, times, root);
  return { shards, balance: landingBalance(files.map(file => fileKey(file, root)), times), slots: shards.length };
}

/**
 * Name how a plan was balanced: by the last measured per-file wall times when every file has one,
 * by those times with new files at their average when some do, and by file count when none do.
 *
 * @param {string[]} files
 * @param {Record<string, number>} [times]
 * @returns {'history'|'history and average'|'file count'}
 */
export function landingBalance(files, times = {}) {
  const known = files.filter(file => Number.isFinite(times[fileKey(file)])).length;
  return known === files.length && known ? 'history' : known ? 'history and average' : 'file count';
}

/** The slowest file with a recorded wall time, which no shard count can beat; null with no history. */
export function landingFloor(files, times = {}) {
  let floor = null;
  for (const file of files) {
    const ms = times[fileKey(file)];
    if (Number.isFinite(ms) && (!floor || ms > floor.ms)) floor = { path: fileKey(file), ms: Math.round(ms) };
  }
  return floor;
}

/** Read the per-file wall-time lines a shard printed, keeping the longest report for each file. */
export function shardFileTimes(output) {
  const times = {};
  for (const line of String(output).split(/\r?\n/u)) {
    if (!line.startsWith(FILE_TIME_LINE)) continue;
    const rest = line.slice(FILE_TIME_LINE.length);
    const space = rest.indexOf(' ');
    const ms = Number(rest.slice(0, space));
    const file = fileKey(rest.slice(space + 1));
    if (space > 0 && Number.isFinite(ms) && ms >= 0 && file) times[file] = Math.max(times[file] ?? 0, ms);
  }
  return times;
}

/** The process environment without this process's own gate markers, so a shard never reuses them. */
function withoutGateMarkers(env) {
  const copy = { ...env };
  for (const key of GATE_MARKERS) delete copy[key];
  return copy;
}

/** Quote one word for the runner's POSIX shell. */
function word(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** One process census, or null when it cannot be taken; a missing census is never an empty machine. */
function census(parseProcessCensus) {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/bin:/usr/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' } }); // budget: one bounded ps call.
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return parseProcessCensus(result.stdout);
}

/**
 * Every process a shard owns: its parent-tree descendants, including detached ones that started
 * their own group or session, plus every member of their groups. Taken before any signal, while the
 * tree still links them, since an orphaned process loses its parent link.
 */
export function shardProcesses(rootPid, rows, parseProcessCensus) {
  if (rows === undefined && typeof parseProcessCensus !== 'function') throw new TypeError('shard census needs its explicit process parser');
  if (rows === undefined) rows = census(parseProcessCensus);
  if (!rows) return null;
  const owned = new Map();
  const children = new Map();
  for (const row of rows.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const queue = rows.has(rootPid) ? [rows.get(rootPid)] : [];
  while (queue.length) {
    const row = queue.shift();
    if (owned.has(row.pid)) continue;
    owned.set(row.pid, row);
    queue.push(...(children.get(row.pid) ?? []));
  }
  const ownGroup = rows.get(process.pid)?.pgid;
  const groups = new Set([...owned.values()].map(row => row.pgid).filter(pgid => pgid !== ownGroup));
  for (const row of rows.values()) if (groups.has(row.pgid) && row.pid !== process.pid) owned.set(row.pid, row);
  return owned;
}

/** The owned processes still alive with the same identity, or null when no census can tell. */
function survivors(owned, parseProcessCensus) {
  const rows = census(parseProcessCensus);
  if (!rows) return null;
  return [...owned.values()].filter(row => rows.get(row.pid)?.started === row.started);
}

/** Signal one process only while it is still the one the shard owned. */
function signalOwned(row, name) {
  try { process.kill(row.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

/**
 * Stop a shard and prove its processes are gone. TERM asks its run-tests to stop through its own
 * custody, which drains every descendant it tracked; whatever the census still finds is signalled
 * here. Returns the processes that could not be shown gone, named by pid and command hash.
 */
async function stopShard(child, closed, parseProcessCensus) {
  const owned = shardProcesses(child.pid, undefined, parseProcessCensus);
  signalOwned({ pid: child.pid }, 'SIGTERM');
  let timer;
  const drained = await Promise.race([closed.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), STOP_GRACE_MS); })]);
  clearTimeout(timer);
  if (!drained) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await closed;
  }
  if (!owned) return ['process census unavailable'];
  for (const name of ['SIGTERM', 'SIGKILL']) {
    const left = survivors(owned, parseProcessCensus);
    if (!left) return ['process census unavailable'];
    if (!left.length) return [];
    for (const row of left) signalOwned(row, name);
    await new Promise(resolveWait => setTimeout(resolveWait, SWEEP_WAIT_MS));
  }
  const left = survivors(owned, parseProcessCensus);
  if (!left) return ['process census unavailable'];
  return left.map(row => `pid ${row.pid} (${row.processSha256.slice(0, 12)})`);
}

/**
 * Whether a red shard's only failures are files their own watchdog stopped: a HUNG or TIMEOUT line, with no first
 * failure that stopped the shard early. Why: one hung file must stay red without leaving every other file not run (#3167).
 */
export function watchdogStoppedOnly(output) {
  const text = String(output ?? '');
  return /run-tests: (?:HUNG|TIMEOUT) file /u.test(text) && !/^Landing gate stopped early after /mu.test(text);
}

/**
 * The time a shard spent in each dispatch step: connecting, sending history the runner lacked, waiting for READY, and
 * running. Why: a one-file shard took 134 s for 54 s of tests, and nothing said which step ate the rest [C7].
 */
function phaseText(record) {
  const at = record.phases;
  if (!at?.start) return '';
  const seconds = (from, to) => (from && to ? ` ${Math.round((to - from) / 100) / 10} s` : ' ?');
  const end = at.start + (record.wallMs ?? 0);
  // The runner's own stages (its source-cache wait, pack transfer and checkout) say what "connect" and "ready" hold.
  const stages = record.stages;
  const stage = name => (Number.isFinite(stages?.[name]) ? ` ${Math.round(stages[name] / 100) / 10} s` : ' ?');
  const inside = stages ? `; cache wait${stage('cacheWaitMs')}, transfer${stage('transferMs')}, materialize${stage('materializeMs')}` : '';
  return ` (connect${seconds(at.connect ?? at.start, at.inventory ?? at.ready ?? end)}, history${at.inventory ? seconds(at.inventory, at['source-sent'] ?? at.ready ?? end) : ' 0 s'}, ready${seconds(at['source-sent'] ?? at.inventory ?? at.connect ?? at.start, at.ready ?? end)}, run${seconds(at.ready, end)}${inside})`;
}

/** Run one shard's files in a local child run-tests that inherits the shard's own gate lease. */
async function runLocalShard({ root, runner, files, args = [], label, lease, stop, collectAll, collectionId, parseProcessCensus }) {
  const env = { ...withoutGateMarkers(process.env), ...gateSlotEnvironment(lease),
    PULLBOARD_LANDING_RUN: '1', [LANDING_SHARD_ENV]: label, [LANDING_COLLECT_ALL_ENV]: collectAll ? '1' : '0', [COLLECTION_ID_ENV]: collectionId ?? '' };
  // Its own process group, so a stop reaches the shard's test files and their children together.
  const child = spawn(process.execPath, [runner, ...args, '--', ...files], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.setEncoding('utf8').on('data', part => chunks.push(part));
  child.stderr.setEncoding('utf8').on('data', part => chunks.push(part));
  const closed = new Promise(resolveClose => {
    child.once('error', error => { chunks.push(`\n${error.message}\n`); resolveClose({ status: 1, signal: null }); });
    child.once('close', (status, signal) => resolveClose({ status, signal }));
  });
  let stopping = null;
  const onStop = () => { stopping = stopShard(child, closed, parseProcessCensus).catch(error => [`stop failed: ${error.message}`]); };
  if (stop.aborted) onStop();
  else stop.addEventListener('abort', onStop, { once: true });
  const { status, signal } = await closed;
  stop.removeEventListener('abort', onStop);
  const unverified = stopping ? await stopping : [];
  return { isGreen: status === 0 && !signal && !stopping, output: chunks.join(''), unverified };
}

/**
 * A fingerprint of exactly what a local shard would run: HEAD, every tracked change against it and
 * the names and contents of the untracked files Git does not ignore. A landing pins it before its
 * first shard; a same-name replacement of an untracked file changes it too.
 *
 * @param {string} root
 * @returns {{ commit: string, fingerprint: string }}
 */
export function landingSource(root) {
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, env: gitChildEnv(root), encoding: 'buffer', maxBuffer: 1024 ** 3 });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed while pinning the landing source`);
    return result.stdout;
  };
  const commit = git(['rev-parse', 'HEAD']).toString('utf8').trim();
  const hash = createHash('sha256').update(commit).update('\0')
    .update(git(['diff', 'HEAD', '--binary', '--no-ext-diff'])).update('\0');
  for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean)) {
    const full = join(root, path);
    let content;
    try {
      const stat = lstatSync(full);
      content = stat.isSymbolicLink() ? `link:${readlinkSync(full)}` : stat.isFile() ? readFileSync(full) : `kind:${stat.mode}`;
    } catch { content = 'missing'; }
    hash.update(path).update('\0').update(content).update('\0');
  }
  return { commit, fingerprint: hash.digest('hex') };
}

/** Runner refusals that mean the host could not run the shard right now, so a local rerun is sound. */
const RERUN_REFUSALS = new Set(RERUNNABLE_RUNNER_REFUSALS);

/**
 * How a sharded landing answers a runner that gave no test result. A lost host or transport, or a
 * setup the runner's own pool refused (#690), permits local recovery only when runner-only is off.
 * Unverified cleanup also takes that host out of this landing. Changed source means the code under test
 * drifted, so the landing fails; so does any refusal this does not know, with no silent retry.
 *
 * @param {unknown} error
 * @param {{ RunnerDropped: Function, Refused: Function }} kinds
 * @returns {{ action: 'rerun'|'quarantine'|'fail', reason: string, code: string|null }|null} null when it is not a runner answer at all.
 */
export function runnerFailureClass(error, { RunnerDropped, Refused }) {
  if (error instanceof RunnerDropped) return { action: 'rerun', reason: 'runner transport lost', code: null };
  if (!(error instanceof Refused)) return null;
  if (RERUN_REFUSALS.has(error.code)) return { action: 'rerun', reason: `runner refused: ${error.code}`, code: error.code };
  if (error.code === 'RUNNER_CLEANUP_TIMEOUT' || error.code === 'RUNNER_SETUP') return { action: 'quarantine', reason: `runner refused: ${error.code}`, code: error.code };
  return { action: 'fail', reason: `runner refused: ${error.code}`, code: error.code };
}

/** A shard's acquisition stopped waiting because the shard ran elsewhere or the landing stopped. */
class NotNeeded extends Error {}

/**
 * Run the landing gate's test files as `count` shards and return one result.
 *
 * The slot this process already holds is a lane of its own: it runs the first shard, then any shard
 * no other slot has taken yet. Every other shard also queues for a slot of its own, locally or on a
 * runner, and whichever slot reaches it first runs it. So a landing always finishes on its own slot,
 * and two landings that hold the only two slots cannot wait on each other.
 *
 * A red shard is a test failure: it stops the others and the landing is red, with no retry. Only an
 * infrastructure failure of a runner (a dropped transport or a runner refusal) reruns that shard,
 * locally, after a named line; both attempts stay in the merged log and profile.
 *
 * @param {{ root: string, runner: string, files: string[], count: number, inherited?: object|null,
 *   needsBrowser?: (files: string[]) => Promise<boolean>, write?: (text: string) => void }} options
 *   `runner` is this repository's apps/cli/src/io/run/tests.js; `inherited` is the gate lease this process already
 *   holds; `write` receives the merged log.
 * @returns {Promise<{ isGreen: boolean, balance: string, shards: object[], files: object[] }>}
 */
export async function runLandingShards({ root, runner, files, args = [], count, inherited = null, fullScope = true, needsBrowser = async () => true, needsGui = shardFiles => testsNeedGui(root, shardFiles), write = text => process.stdout.write(text), remoteRun, timing, parseProcessCensus, runnerAdmission = gateRunnerAdmission() }) {
  if (typeof parseProcessCensus !== 'function') throw new TypeError('landing shards need the explicit process census parser');
  const runnerOnly = runnerAdmission.runnerOnly === true;
  const selectionAt = performance.now();
  const collectAll = process.env[LANDING_COLLECT_ALL_ENV] === '1';
  const collectionId = process.env[COLLECTION_ID_ENV];
  const release = process.env[RELEASE_EXECUTORS_ENV] ? releasePlacement(process.env[RELEASE_EXECUTORS_ENV]) : null;
  if (release && !collectAll) throw new Error('a release requires complete native collection');
  const { Refused } = await import('../../../kernel/index.js');
  if (runnerOnly && release?.executors.some(executor => executor.kind === 'local')) {
    throw new Refused('RUNNER_SOURCE', 'runner-only landing refuses the required local release executor; run this captured release on a machine allowing local tests');
  }
  const releaseStartedAt = new Date().toISOString();
  const collectionKey=file=>relative(root,resolve(root,file)).split(sep).join('/');
  const { withLandingGateSlot } = await import('../../../gate/index.js');
  const runners = await import('../../../runners/index.js');
  const { RunnerDropped } = runners;
  // A test may stand in for the SSH round trip to make a runner answer with a given refusal.
  const runOnRunnerAsync = remoteRun ?? runners.runOnRunnerAsync;
  const quarantined = new Map();
  // Every local shard, first run or rerun, must run exactly this source or refuse by name.
  const pinned = landingSource(root);
  const pinnedTree = release ? headTree(root) : null;
  const history = readFileTimes(root);
  const plan = release ? await planReleaseShards(files, release.executors, history, needsBrowser, needsGui,
    shardFiles => cpuRunnerRequired(root, shardFiles))
    : planLandingShards(files, count, history, root);
  const balance = landingBalance(files, history);
  const total = plan.length;
  const stopper = new AbortController();
  const stop = stopper.signal;
  let firstFailure = null;
  // The parent's own markers would make every shard reuse its one lease; each lane passes its own.
  const saved = Object.fromEntries(GATE_MARKERS.map(key => [key, process.env[key]]));
  for (const key of GATE_MARKERS) delete process.env[key];
  write(`# landing shards: ${total} balanced by ${balance} (${plan.map((shard, index) => `${index + 1}/${total} ${shard.files.length} files`).join(', ')})\n`);
  const floor = landingFloor(files, history);
  // The slowest single file bounds the gate however many shards there are.
  if (floor) write(`# landing floor: ${floor.ms} ms ${floor.path}\n`);
  timing?.phase('selectionMs', selectionAt);
  const setupAt = performance.now();

  let wake = () => {};
  let changed = new Promise(resolveChange => { wake = resolveChange; });
  /** Tell the parent's lane that a shard became free to take or finished. */
  const signalChange = () => { const resolveChange = wake; changed = new Promise(next => { wake = next; }); resolveChange(); };
  const entries = await Promise.all(plan.map(async (shard, index) => ({ shard, label: `${index + 1}/${total}`,
    browser: await needsBrowser(shard.files), gui: await needsGui(shard.files), claimed: false, localOnly: false, done: false, attempts: [], status: null })));

  timing?.phase('setupMs', setupAt);
  /** Seconds since this run started, so the log attributes the time around the shards [C7]. */
  const sinceStart = () => Math.round((performance.now() - selectionAt) / 100) / 10;
  write(`# landing timing: selection ${Math.round(setupAt - selectionAt)} ms, setup ${Math.round(performance.now() - setupAt)} ms, shards dispatched at +${sinceStart()} s\n`);

  /** A remote parent's slot cannot take a GUI file unless its own advertised capability permits it. */
  const inheritedCanRun = entry => (!runnerOnly || inherited?.runnerExecution === true || Boolean(inherited?.runner))
    && (!entry.gui || !inherited?.runner || inherited.runner.gui === true)
    && (!entry.shard.executor || (inherited?.runner ? inherited.runner.host === entry.shard.executor.id
      : entry.shard.executor.id === localRunnerDescriptor(null, null).id));

  /** Run one attempt of a shard on a lease: a local child, or the runner it names. */
  const attempt = async (entry, lease) => {
    const started = performance.now();
    const number = entry.attempts.length + 1;
    if (!lease.runner) {
      if (runnerOnly && !lease.runnerExecution) throw new Refused('RUNNER_SOURCE', 'runner-only landing refuses a local shard lease; no local fallback');
      if (release && cpuRunnerRequired(root, entry.shard.files)) {
        return { attempt: number, host: 'local', outcome: 'refused', reason: 'CPU-runner work cannot prove local release participation', output: '', wallMs: Math.round(performance.now() - started) };
      }
      const drifted = () => landingSource(root).fingerprint !== pinned.fingerprint;
      /** A local result on other source than the landing pinned is never a result for this landing. */
      const sourceChanged = when => {
        write(`landing shard ${entry.label}: [LANDING_SOURCE_CHANGED] the checkout changed from the landing's pinned source ${pinned.commit.slice(0, 12)} ${when} this shard ran; restore that commit with no other changes and run the landing again\n`);
        return { attempt: number, host: 'local', outcome: 'refused', reason: 'landing refused: LANDING_SOURCE_CHANGED', output: '', wallMs: Math.round(performance.now() - started) };
      };
      if (drifted()) return sourceChanged('before');
      const run = await runLocalShard({ root, runner, files: entry.shard.files, args, label: entry.label, lease, stop, collectAll, collectionId, parseProcessCensus });
      if (run.unverified.length) { // Fail closed: name what may still run, as a runner's unverified cleanup does.
        write(`landing shard ${entry.label}: [LANDING_SHARD_CLEANUP_UNVERIFIED] the stopped shard's processes could not be shown gone: ${run.unverified.join(', ')}; inspect and stop them before another run\n`);
        return { attempt: number, host: 'local', outcome: 'refused', reason: 'landing refused: LANDING_SHARD_CLEANUP_UNVERIFIED', output: run.output, wallMs: Math.round(performance.now() - started) }; }
      if (!stop.aborted && drifted()) return sourceChanged('while');
      return { attempt: number, host: 'local', outcome: run.isGreen ? 'green' : 'red', output: run.output, wallMs: Math.round(performance.now() - started),
        ...(release ? { executor: localRunnerDescriptor(null, null).id, head: pinned.commit, tree: pinnedTree,
          command: createHash('sha256').update(JSON.stringify([process.execPath, runner, ...entry.shard.files])).digest('hex') } : {}) };
    }
    const command = `${COLLECTION_ID_ENV}=${word(collectionId ?? '')} ${LANDING_COLLECT_ALL_ENV}=${collectAll ? '1' : '0'} ${LANDING_SHARD_ENV}=${word(entry.label)} ${['node', './apps/cli/src/io/run/tests.js', ...args, '--', ...entry.shard.files].map(word).join(' ')}`;
    try {
      const run = await runOnRunnerAsync(root, command, { runner: lease.runner, source: lease.source, browser: lease.browser,
        metadata: { ...(lease.runMetadata ?? {}), landing: true, gui: entry.gui, auditCoverage: Boolean(process.env.PULLBOARD_AUDIT_COVERAGE_REPORTER) }, signal: stop });
      // A runner that could not prepare its checkout ran no test: that is infrastructure to requeue, never a red to
      // hold the batch on. A locked slot database on .54 held #2794 as "no accounted failure" on 6 Nov [C7].
      const setupRefused = !run.isGreen && /^runner setup refused:/u.test(run.output ?? '');
      return { attempt: number, host: lease.runner.host, outcome: run.isGreen ? 'green' : setupRefused ? 'infrastructure' : 'red', ...(setupRefused ? { reason: run.output.split('\n')[0].slice(0, 160) } : {}), output: run.output, wallMs: Math.round(performance.now() - started), phases: run.phases ?? null, stages: run.sourcePreparation?.stages ?? null,
        ...(release ? { executor: run.executionRunner, head: run.executionSource?.commit, tree: run.executionSource?.tree,
          command: createHash('sha256').update(command).digest('hex') } : {}) };
    } catch (error) {
      // A stop ends the runner's transport on purpose; that shard was stopped, not dropped.
      if (stop.aborted) return { attempt: number, host: lease.runner.host, outcome: 'stopped', output: '', wallMs: Math.round(performance.now() - started) };
      const failure = runnerFailureClass(error, { RunnerDropped, Refused });
      if (!failure) throw error;
      const host = lease.runner.host;
      const message = error instanceof Refused ? error.message : '';
      if (message) write(`landing shard ${entry.label}: runner ${host} refused it: ${message}\n`);
      if (failure.action === 'quarantine' && !quarantined.has(host)) {
        quarantined.set(host, message);
        write(`landing runner ${host} quarantined for the rest of this landing: ${message}\n`);
      }
      // Infrastructure, not a test result: the runner could not give this shard a complete answer.
      return { attempt: number, host, outcome: failure.action === 'fail' ? 'refused' : 'infrastructure', reason: failure.reason,
        output: error.runnerAttempt?.output ?? '', wallMs: Math.round(performance.now() - started) };
    }
  };

  /** Record an attempt's outcome, stopping the landing at the first test failure. */
  const settle = (entry, record) => {
    if(collectionId) {
      const report=parseCollectionReports(record.output,{id:collectionId,scope:'shard',shard:entry.label,
        plannedFiles:entry.shard.files.map(collectionKey),requireComplete:false});
      record.collectionComplete=report?.complete===true;
      record.cleanupVerified=report?.cleanupVerified;
    }
    const stopped = record.outcome !== 'green' && (stop.aborted || (!collectAll && firstFailure !== null));
    const status = record.outcome === 'infrastructure' && !stopped ? 'infrastructure' : stopped ? 'stopped' : record.outcome;
    entry.attempts.push({ ...record, status });
    write(`# landing shard ${entry.label} attempt ${record.attempt} on ${record.host}: ${status}${record.reason ? ` (${record.reason})` : ''} in ${record.wallMs} ms${phaseText(record)}\n`);
    if (record.output) write(record.output.endsWith('\n') ? record.output : `${record.output}\n`);
    if (status === 'infrastructure' && !release && !runnerOnly) {
      write(`landing shard ${entry.label}: runner ${record.host} failed mid-shard; rerunning shard ${entry.label} locally\n`);
      entry.claimed = false;
      entry.localOnly = true;
      acquire(entry);
    } else if ((status === 'refused' || status === 'infrastructure') && !release && !stop.aborted && entry.attempts.length < 3) {
      // One runner refusing or dropping a shard is that runner's fault, not the batch's: the shard queues again and
      // the pool hands it to an available runner. Why: one RUNNER_UNAVAILABLE stopped every other shard and blocked an
      // 8-item batch with no test red at all [C7].
      write(`landing shard ${entry.label}: runner ${record.host} ${status}${record.reason ? ` (${record.reason})` : ''}; queuing shard ${entry.label} again (attempt ${entry.attempts.length + 1})\n`);
      entry.claimed = false;
      acquire(entry);
    } else {
      entry.done = true;
      entry.status = status;
      // A shard red only from a file its watchdog stopped (hung or past its wall) never stops the others (#3167).
      if (status === 'red' && watchdogStoppedOnly(record.output)) return signalChange();
      if (status === 'red' || status === 'refused' || status === 'infrastructure') {
        firstFailure ??= entry.label;
        if (status === 'refused' || status === 'infrastructure' || !collectAll) stopper.abort();
      }
    }
    signalChange();
  };

  /** Run a claimed shard on a lease, unless the landing already stopped. */
  const runOnLease = async (entry, lease) => {
    if (entry.done) return;
    if (stop.aborted) {
      entry.done = true;
      entry.status = 'stopped';
      entry.attempts.push({ attempt: entry.attempts.length + 1, host: 'none', outcome: 'stopped', status: 'stopped', wallMs: 0, output: '' });
      write(`# landing shard ${entry.label} attempt ${entry.attempts.length} on none: stopped in 0 ms\n`);
      signalChange();
      return;
    }
    entry.running = true;
    try { settle(entry, await attempt(entry, lease)); }
    finally { entry.running = false; }
  };

  const failures = [];
  const acquisitions = new Set();
  /** Queue this shard for a slot of its own; the parent's lane may take it first. */
  const acquire = (entry) => {
    const localOnly = entry.localOnly;
    const running = withLandingGateSlot(root, async lease => {
      lease.timingOperation = 'landing-shard';
      if (entry.claimed || entry.done) return;
      // A host quarantined in this landing gets no more shards; queue again for a local slot.
      if (lease.runner && quarantined.has(lease.runner.host)) {
        if (runnerOnly) {
          // No local fallback and the pool offers only a quarantined runner: the shard ends as a typed infrastructure result, never a throw out of the run [C7].
          write(`landing shard ${entry.label}: runner-only landing refuses quarantined runner ${lease.runner.host}; there is no local fallback\n`);
          entry.done = true;
          entry.status = 'infrastructure';
          firstFailure ??= entry.label;
          stopper.abort();
          signalChange();
          return;
        }
        return 'divert';
      }
      entry.claimed = true;
      await runOnLease(entry, lease);
    }, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, landing: true, browser: entry.browser, gui: entry.gui, ...runnerAdmission, remote: !localOnly, kind: 'landing', item: `shard ${entry.label}`,
      ...(entry.shard.executor ? { requiredExecutor: entry.shard.executor.kind === 'local'
        ? { kind: 'local' } : { kind: 'ssh', host: entry.shard.executor.host } } : {}),
      onWait: () => { if (entry.claimed || entry.done || stop.aborted) throw new NotNeeded(); } });
    acquisitions.add(running);
    running.then(() => acquisitions.delete(running), () => acquisitions.delete(running));
    running.then(result => {
      if (result !== 'divert' || entry.claimed || entry.done) return;
      entry.localOnly = true;
      acquire(entry);
    }, () => {});
    running.catch(error => {
      if (error instanceof NotNeeded) {
        // A stopped shard that was only waiting for a slot is recorded as stopped here.
        if (stop.aborted && !entry.done && !entry.running) runOnLease(entry, {}).catch(() => {});
        return;
      }
      failures.push(error);
      stopper.abort();
      signalChange();
    });
  };

  /** The parent's own slot: run free shards one after another until every shard is done. */
  const lane = async () => {
    while (!entries.every(entry => entry.done) && !failures.length) {
      const next = entries.find(entry => !entry.claimed && !entry.done && inheritedCanRun(entry));
      if (!next) { await changed; continue; }
      next.claimed = true;
      await runOnLease(next, inherited);
    }
  };

  let shards;
  try {
    for (const entry of entries) if (!inherited || entry !== entries[0] || !inheritedCanRun(entry)) acquire(entry);
    if (inherited) await lane();
    while (!entries.every(entry => entry.done) && !failures.length) await changed;
    if (failures.length) throw failures[0];
    shards = entries;
  } finally {
    // A completed shard can signal before its admission finishes releasing the owned slot.
    if (!entries.every(entry => entry.done)) { stopper.abort(); signalChange(); }
    while (acquisitions.size) await Promise.allSettled([...acquisitions]);
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
  if (failures.length) throw failures[0];
  const merged = [];
  const measured = {};
  for (const entry of shards) {
    const last = entry.attempts.at(-1);
    const times = shardFileTimes(last?.output ?? '');
    for (const file of entry.shard.files.map(fileKey)) {
      const ms = times[file];
      if (Number.isFinite(ms)) measured[file] = ms;
      merged.push({ path: file, shard: entry.label, host: last?.host ?? 'none', durationMs: Number.isFinite(ms) ? ms : null });
    }
  }
  for (const file of merged.sort((a, b) => a.path.localeCompare(b.path))) {
    write(`# landing file ${file.shard} ${file.host} ${file.durationMs ?? '-'} ${file.path}\n`);
  }
  if(collectAll&&collectionId) {
    const planned=files.map(collectionKey);
    const completed=shards.filter(entry=>['red','green'].includes(entry.status)&&entry.attempts.at(-1)?.collectionComplete===true)
      .flatMap(entry=>entry.shard.files.map(collectionKey));
    const complete=!stop.aborted&&shards.every(entry=>['red','green'].includes(entry.status)&&entry.attempts.at(-1)?.collectionComplete===true);
    write(formatCollectionReport({id:collectionId,scope:'suite',full:fullScope,plannedFiles:planned,completedFiles:completed,complete,
      cleanupVerified:shards.every(entry=>entry.attempts.at(-1)?.cleanupVerified===true)}));
  }
  if (release) {
    write(RELEASE_PARTICIPATION_PREFIX + JSON.stringify({ version: 1, id: release.id, head: pinned.commit, tree: pinnedTree,
      required: release.executors.map(entry => entry.id), startedAt: releaseStartedAt,
      shards: shards.map(entry => {
        const last = entry.attempts.at(-1);
        return { shard: entry.label, files: entry.shard.files.map(collectionKey).sort(), executor: last?.executor ?? null,
          head: last?.head ?? null, tree: last?.tree ?? null, command: last?.command ?? null, green: entry.status === 'green',
          complete: last?.collectionComplete === true, cleanupVerified: last?.cleanupVerified === true };
      }) }) + '\n');
  }
  write(`# landing timing: every shard settled at +${sinceStart()} s\n`);
  const isGreen = shards.every(entry => entry.status === 'green') && shardSelectionMatched(args, shards.map(entry => entry.attempts.at(-1)?.output ?? ''), text => process.stderr.write(text));
  write(`# landing result: ${isGreen ? 'green' : collectAll && !stop.aborted ? `red, ${shards.filter(entry => entry.status === 'red').length} failing shard(s); all test shards collected` : `red, first failure in shard ${firstFailure ?? shards.find(entry => entry.status !== 'green')?.label}`}\n`);
  if (Object.keys(measured).length) writeFileTimes(root, measured);
  return { isGreen, balance, full: fullScope && shards.every(entry => entry.attempts.at(-1)?.collectionComplete === true),
    shards: shards.map(entry => ({ shard: entry.label, status: entry.status,
      attempts: entry.attempts.map(({ output, ...record }) => record) })),
    files: merged };
}

/** Print this shard's per-file wall times for its orchestrator; a missing record prints nothing. */
export function printShardFileTimes(path, write = text => process.stdout.write(text)) {
  if (!path || !existsSync(path)) return;
  const times = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const { file, ms } = JSON.parse(line);
      if (typeof file === 'string' && Number.isFinite(ms)) times[fileKey(file)] = Math.max(times[fileKey(file)] ?? 0, ms);
    } catch { /* A torn last line from a killed file process carries no time. */ }
  }
  for (const [file, ms] of Object.entries(times)) write(`${FILE_TIME_LINE}${Math.round(ms)} ${file}\n`);
}

/** Supply landing policy and release orchestration ports without adding higher imports to their consumers. */
export function landingExecutionServices() {
  return Object.freeze({ constrainedLandingHost, captureReleaseQueue, releaseExecutors });
}
