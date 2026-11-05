/**
 * The landing gate in shards [C7,V4]: split the tracked test files into balanced shards, run each on
 * a free local gate slot or a registered runner, and report one result. One red shard stops the rest,
 * and a shard whose runner fails mid-run reruns locally.
 */
import {
  spawn,
  spawnSync,
} from './windows-child-process.js';
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
  join,
} from 'node:path';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  gitChildEnv,
  repoInfo,
} from './git.js';
import { testsNeedGui } from './gui-admission.js';
import { parseProcessCensus } from './process-census.js';
import {
  BROWSER_SLOT_HELD_ENV,
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
  gateSlotEnvironment,
} from './resources.js';

/** Environment variable naming the shard a nested run-tests process runs, as `<i>/<n>`. */
export const LANDING_SHARD_ENV = 'PULLBOARD_LANDING_SHARD';
/** Environment variable naming the file where each test file process appends its wall time. */
export const LANDING_FILE_TIMES_ENV = 'PULLBOARD_LANDING_FILE_TIMES';
/** Prefix of the per-file wall-time lines a shard prints for its orchestrator. */
export const FILE_TIME_LINE = '# landing-file-ms ';

const GATE_MARKERS = [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV];
// Budget: a stopped shard's run-tests drains its owned processes within its 12 s custody limit; past
// this its group is killed.
const STOP_GRACE_MS = 20_000;
// Budget: each signal round of the final sweep waits this long for a process to go.
const SWEEP_WAIT_MS = 1_000;

/** Where the last landing's per-file wall times live, shared by every worktree of the repository. */
export function fileTimesPath(root) {
  return join(repoInfo(root).commonDir, 'pullboard', 'landing-file-times.json');
}

/** Read the last per-file wall times; a missing or unreadable record means none are known. */
export function readFileTimes(root) {
  try {
    const value = JSON.parse(readFileSync(fileTimesPath(root), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value.files ?? {}).filter(([, ms]) => Number.isFinite(ms) && ms >= 0));
  } catch { return {}; }
}

/** Keep the newest wall time for every file this landing measured, beside the older ones. */
function writeFileTimes(root, measured) {
  const path = fileTimesPath(root);
  const files = { ...readFileTimes(root), ...measured };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Normalize a test file path to its repository-relative form, without a leading `./`. */
export function fileKey(file) {
  return String(file).replace(/^\.\//u, '');
}

/**
 * Split files into at most `count` shards by weight, heaviest first onto the lightest shard.
 * A file with a known wall time weighs that time; with no times at all every file weighs one, so the
 * split falls back to file count. A new file weighs the average known time. Empty shards are dropped.
 *
 * @param {string[]} files
 * @param {number} count
 * @param {Record<string, number>} [times] - Last wall time in ms by repository-relative path.
 * @returns {{ files: string[], weight: number }[]}
 */
export function planLandingShards(files, count, times = {}) {
  const known = files.map(file => times[fileKey(file)]).filter(ms => Number.isFinite(ms));
  const average = known.length ? known.reduce((sum, ms) => sum + ms, 0) / known.length : 1;
  const weight = file => known.length ? (Number.isFinite(times[fileKey(file)]) ? times[fileKey(file)] : average) : 1;
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
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
function census() {
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
export function shardProcesses(rootPid, rows = census()) {
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
function survivors(owned) {
  const rows = census();
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
async function stopShard(child, closed) {
  const owned = shardProcesses(child.pid);
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
    const left = survivors(owned);
    if (!left) return ['process census unavailable'];
    if (!left.length) return [];
    for (const row of left) signalOwned(row, name);
    await new Promise(resolveWait => setTimeout(resolveWait, SWEEP_WAIT_MS));
  }
  const left = survivors(owned);
  if (!left) return ['process census unavailable'];
  return left.map(row => `pid ${row.pid} (${row.processSha256.slice(0, 12)})`);
}

/** Run one shard's files in a local child run-tests that inherits the shard's own gate lease. */
async function runLocalShard({ root, runner, files, label, lease, stop }) {
  const env = { ...withoutGateMarkers(process.env), ...gateSlotEnvironment(lease),
    PULLBOARD_LANDING_RUN: '1', [LANDING_SHARD_ENV]: label };
  // Its own process group, so a stop reaches the shard's test files and their children together.
  const child = spawn(process.execPath, [runner, ...files], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.setEncoding('utf8').on('data', part => chunks.push(part));
  child.stderr.setEncoding('utf8').on('data', part => chunks.push(part));
  const closed = new Promise(resolveClose => {
    child.once('error', error => { chunks.push(`\n${error.message}\n`); resolveClose({ status: 1, signal: null }); });
    child.once('close', (status, signal) => resolveClose({ status, signal }));
  });
  let stopping = null;
  const onStop = () => { stopping = stopShard(child, closed).catch(error => [`stop failed: ${error.message}`]); };
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
const RERUN_REFUSALS = new Set(['RUNNER_SETUP_REFUSED', 'RESOURCE_LEASE_LOST', 'RUNNER_BROWSER_SLOT_REQUIRED', 'RUNNER_GUI_SESSION_REQUIRED']);

/**
 * How a sharded landing answers a runner that gave no test result. A lost host or transport, or a
 * setup the runner's own pool refused (#690), reruns the shard locally. An unverified cleanup also
 * reruns locally, but takes that host out of this landing. Changed source means the code under test
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
  if (error.code === 'RUNNER_CLEANUP_TIMEOUT') return { action: 'quarantine', reason: `runner refused: ${error.code}`, code: error.code };
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
 *   `runner` is this repository's bin/run-tests.js; `inherited` is the gate lease this process already
 *   holds; `write` receives the merged log.
 * @returns {Promise<{ isGreen: boolean, balance: string, shards: object[], files: object[] }>}
 */
export async function runLandingShards({ root, runner, files, count, inherited = null, needsBrowser = async () => true, needsGui = shardFiles => testsNeedGui(root, shardFiles), write = text => process.stdout.write(text), remoteRun }) {
  const { withLandingGateSlot } = await import('./gate.js');
  const runners = await import('./runners.js');
  const { RunnerDropped } = runners;
  // A test may stand in for the SSH round trip to make a runner answer with a given refusal.
  const runOnRunnerAsync = remoteRun ?? runners.runOnRunnerAsync;
  const quarantined = new Map();
  // Every local shard, first run or rerun, must run exactly this source or refuse by name.
  const pinned = landingSource(root);
  const { Refused } = await import('./refused.js');
  const history = readFileTimes(root);
  const plan = planLandingShards(files, count, history);
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

  let wake = () => {};
  let changed = new Promise(resolveChange => { wake = resolveChange; });
  /** Tell the parent's lane that a shard became free to take or finished. */
  const signalChange = () => { const resolveChange = wake; changed = new Promise(next => { wake = next; }); resolveChange(); };
  const entries = await Promise.all(plan.map(async (shard, index) => ({ shard, label: `${index + 1}/${total}`,
    browser: await needsBrowser(shard.files), gui: await needsGui(shard.files), claimed: false, localOnly: false, done: false, attempts: [], status: null })));

  /** A remote parent's slot cannot take a GUI file unless its own advertised capability permits it. */
  const inheritedCanRun = entry => !entry.gui || !inherited?.runner || inherited.runner.gui === true;

  /** Run one attempt of a shard on a lease: a local child, or the runner it names. */
  const attempt = async (entry, lease) => {
    const started = Date.now();
    const number = entry.attempts.length + 1;
    if (!lease.runner) {
      const drifted = () => landingSource(root).fingerprint !== pinned.fingerprint;
      /** A local result on other source than the landing pinned is never a result for this landing. */
      const sourceChanged = when => {
        write(`landing shard ${entry.label}: [LANDING_SOURCE_CHANGED] the checkout changed from the landing's pinned source ${pinned.commit.slice(0, 12)} ${when} this shard ran; restore that commit with no other changes and run the landing again\n`);
        return { attempt: number, host: 'local', outcome: 'refused', reason: 'landing refused: LANDING_SOURCE_CHANGED', output: '', wallMs: Date.now() - started };
      };
      if (drifted()) return sourceChanged('before');
      const run = await runLocalShard({ root, runner, files: entry.shard.files, label: entry.label, lease, stop });
      if (run.unverified.length) {
        // Fail closed: name what may still run, as a runner's unverified cleanup does.
        write(`landing shard ${entry.label}: [LANDING_SHARD_CLEANUP_UNVERIFIED] the stopped shard's processes could not be shown gone: ${run.unverified.join(', ')}; inspect and stop them before another run\n`);
      }
      if (!stop.aborted && drifted()) return sourceChanged('while');
      return { attempt: number, host: 'local', outcome: run.isGreen ? 'green' : 'red', output: run.output, wallMs: Date.now() - started };
    }
    const command = `${LANDING_SHARD_ENV}=${word(entry.label)} ${['node', './bin/run-tests.js', ...entry.shard.files].map(word).join(' ')}`;
    try {
      const run = await runOnRunnerAsync(root, command, { runner: lease.runner, source: lease.source, browser: lease.browser,
        metadata: { ...(lease.runMetadata ?? {}), landing: true, gui: entry.gui }, signal: stop });
      return { attempt: number, host: lease.runner.host, outcome: run.isGreen ? 'green' : 'red', output: run.output, wallMs: Date.now() - started };
    } catch (error) {
      // A stop ends the runner's transport on purpose; that shard was stopped, not dropped.
      if (stop.aborted) return { attempt: number, host: lease.runner.host, outcome: 'stopped', output: '', wallMs: Date.now() - started };
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
        output: error.runnerAttempt?.output ?? '', wallMs: Date.now() - started };
    }
  };

  /** Record an attempt's outcome, stopping the landing at the first test failure. */
  const settle = (entry, record) => {
    const stopped = record.outcome !== 'green' && (stop.aborted || firstFailure !== null);
    const status = record.outcome === 'infrastructure' && !stopped ? 'infrastructure' : stopped ? 'stopped' : record.outcome;
    entry.attempts.push({ ...record, status });
    write(`# landing shard ${entry.label} attempt ${record.attempt} on ${record.host}: ${status}${record.reason ? ` (${record.reason})` : ''} in ${record.wallMs} ms\n`);
    if (record.output) write(record.output.endsWith('\n') ? record.output : `${record.output}\n`);
    if (status === 'infrastructure') {
      write(`landing shard ${entry.label}: runner ${record.host} failed mid-shard; rerunning shard ${entry.label} locally\n`);
      entry.claimed = false;
      entry.localOnly = true;
      acquire(entry);
    } else {
      entry.done = true;
      entry.status = status;
      if (status === 'red' || status === 'refused') {
        firstFailure = entry.label;
        stopper.abort();
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
  /** Queue this shard for a slot of its own; the parent's lane may take it first. */
  const acquire = (entry) => {
    const localOnly = entry.localOnly;
    const running = withLandingGateSlot(root, async lease => {
      if (entry.claimed || entry.done) return;
      // A host quarantined in this landing gets no more shards; queue again for a local slot.
      if (lease.runner && quarantined.has(lease.runner.host)) return 'divert';
      entry.claimed = true;
      await runOnLease(entry, lease);
    }, { landing: true, browser: entry.browser, gui: entry.gui, remote: !localOnly, kind: 'landing', item: `shard ${entry.label}`,
      onWait: () => { if (entry.claimed || entry.done || stop.aborted) throw new NotNeeded(); } });
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
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
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
  const isGreen = shards.every(entry => entry.status === 'green');
  write(`# landing result: ${isGreen ? 'green' : `red, first failure in shard ${firstFailure ?? shards.find(entry => entry.status !== 'green')?.label}`}\n`);
  if (Object.keys(measured).length) writeFileTimes(root, measured);
  return { isGreen, balance,
    shards: shards.map(entry => ({ shard: entry.label, status: entry.status,
      attempts: entry.attempts.map(({ output, ...record }) => record) })),
    files: merged };
}

/** Read the merged shard lines from a gate log into profile fields, or null for an unsharded run. */
export function landingShardProfile(output) {
  const shards = [];
  const files = [];
  let balance = null;
  let floor = null;
  const quarantined = [];
  const unverified = [];
  for (const line of String(output).split(/\r?\n/u)) {
    const plan = /^# landing shards: \d+ balanced by (history|history and average|file count) \(/u.exec(line);
    if (plan) balance = plan[1];
    const leftover = /^landing shard (\d+\/\d+): \[LANDING_SHARD_CLEANUP_UNVERIFIED\] the stopped shard's processes could not be shown gone: (.*); inspect/u.exec(line);
    if (leftover) unverified.push({ shard: leftover[1], processes: leftover[2] });
    const held = /^landing runner (\S+) quarantined for the rest of this landing: (.*)$/u.exec(line);
    if (held) quarantined.push({ host: held[1], message: held[2] });
    const slowest = /^# landing floor: (\d+) ms (.+)$/u.exec(line);
    if (slowest) floor = { path: slowest[2], ms: Number(slowest[1]) };
    const shard = /^# landing shard (\d+\/\d+) attempt (\d+) on (\S+): (green|red|stopped|infrastructure|refused)(?: \(([^)]*)\))? in (\d+) ms$/u.exec(line);
    if (shard) shards.push({ shard: shard[1], attempt: Number(shard[2]), host: shard[3], status: shard[4], reason: shard[5] ?? null, wallMs: Number(shard[6]) });
    const file = /^# landing file (\d+\/\d+) (\S+) (\d+|-) (.+)$/u.exec(line);
    if (file) files.push({ path: file[4], shard: file[1], host: file[2], durationMs: file[3] === '-' ? null : Number(file[3]) });
  }
  return shards.length ? { balance, floor, quarantined, unverified, shards, files } : null;
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
