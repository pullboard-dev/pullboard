/**
 * Read every wait surface on this machine, read-only, as rows the wait audit judges [C7]: resource pools and their
 * waiters, checkout leases and writers, board and resource database writers, the submit hand-off queue, gate jobs and
 * their spans, landing runs, runner jobs over ssh, and orphaned Pullboard processes.
 *
 * Why read-only: the audit runs every minute and `pullboard waits` must answer in under a second, so it never takes
 * a queue turn or a board write; the reclaims in waits.js are separate and exact.
 */
import { execFile } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runsFilePath } from '../../../store/index.js';
import { elapsedMs } from '../logic/budgets.js';
import { storeName } from './store-names.js';
import { fileSystemAdapter } from '../../../fs/index.js';

/** The one file-system adapter this file reads through [C7]. */
const fs = fileSystemAdapter();

// Budget: the job lease a runner's renewal extends (the jobs cell's LEASE_MS, two minutes), so a lease's last renewal is its end minus this.
const LEASE_RENEW_WINDOW_MS = 120_000;

/** Whether a pid names a running process; EPERM is someone else's live process. */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * Parse `ps -axo pid=,ppid=,etime=,lstart=,command=` into a map by pid. lstart is always five words, so the command
 * is everything after them.
 */
function parseCensus(text) {
  const census = new Map();
  for (const line of String(text).split('\n')) {
    const words = line.trim().split(/\s+/u);
    if (words.length < 9) continue;
    const pid = Number(words[0]), ppid = Number(words[1]), age = elapsedMs(words[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || age === null) continue;
    census.set(pid, { pid, ppid, ageMs: age, started: words.slice(3, 8).join(' '), command: words.slice(8).join(' ') });
  }
  return census;
}

/** One bounded ps of every local process; an unreadable ps is an empty census, never a guess. */
export function localCensus() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,etime=,lstart=,command='], { encoding: 'utf8', timeout: 2_000,
    maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' } });
  return result.error || result.status !== 0 ? new Map() : parseCensus(result.stdout);
}

/** What a process is doing, from its command line, short enough for a table and an item brief. */
function doing(census, pid) {
  const row = census.get(pid);
  return row ? row.command.replace(/^\S*\/node(?:\s+--\S+)*\s+/u, 'node ').slice(0, 240) : null;
}

/** Open a SQLite file read-only, or null when it does not exist or cannot be opened. */
function readOnly(file) {
  if (!fs.exists(file)) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 200');
    return db;
  } catch { return null; }
}

/** The age of a file from its modification time; null when it is gone. */
function fileAge(file, now) {
  try { return Math.max(0, now - fs.stat(file).mtimeMs); } catch { return null; }
}

/**
 * Whether a waiter is queued behind runners that each name why they cannot take it: busy, quarantined, kept for timed checks
 * or overloaded. That is a queue wait; the busy runner's holders and a quarantined runner's own runner-unavailable row carry
 * the budget (#6857, #8023). Only a runner reported available leaves a wait with no holder and no cause, which stays a hold.
 */
function queuedForNamedRunners(row) {
  if (row.name !== 'gate' || !row.reasons) return false;
  try {
    const runners = JSON.parse(row.reasons);
    return Array.isArray(runners) && runners.length > 0 && runners.every(runner => !String(runner.reason).startsWith('available'));
  } catch { return false; }
}

/**
 * Resource pool holders and waiters, one row per pool with a holder or a waiter. A checkout-session pool is the
 * checkout's write lease. A holder whose pid is gone is dead, and the queue's own prune reclaims it.
 */
export function readPools(file, scope, now, census) {
  const db = readOnly(file);
  if (!db) return { rows: [], unavailable: [] };
  try {
    const holders = db.prepare('SELECT name, pid, agent, since, item, kind FROM holder ORDER BY since').all();
    const hasReasons = db.prepare("SELECT 1 FROM pragma_table_info('waiter') WHERE name = 'runner_wait_reasons'").get();
    const waiters = db.prepare(`SELECT name, pid, agent, since, item, kind${hasReasons ? ", runner_wait_reasons AS reasons" : ''} FROM waiter ORDER BY ticket`).all().filter(row => !queuedForNamedRunners(row));
    const unavailable = scope === 'machine' && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_unavailable'").get()
      ? db.prepare('SELECT host, since, detail FROM runner_unavailable').all() : [];
    const names = [...new Set([...holders, ...waiters].map(row => row.name))].sort();
    const label = row => `${row.agent}${row.item ? ` #${row.item}` : ''}${row.kind ? ` ${row.kind}` : ''}`;
    const rows = names.map(name => {
      const held = holders.filter(row => row.name === name);
      const oldest = held[0];
      const queued = waiters.filter(row => row.name === name).map(row => ({ label: label(row), pid: row.pid, ageMs: Math.max(0, now - Date.parse(row.since)), context: doing(census, row.pid) }));
      const dead = held.filter(row => !pidAlive(row.pid)).map(row => row.pid);
      const surface = name.startsWith('checkout-session:') ? 'checkout-lease' : 'pool';
      return { surface, key: `${scope}:${name.replace(/:[a-f0-9]{16,}$/u, '')}:${oldest ? oldest.agent.replace(/^pid-\d+$/u, 'pid') : 'none'}`,
        holder: oldest ? `${name} by ${label(oldest)}${held.length > 1 ? ` (+${held.length - 1} more)` : ''}` : `${name} (no holder)`,
        pid: oldest?.pid ?? null, ageMs: oldest ? Math.max(0, now - Date.parse(oldest.since)) : (queued[0]?.ageMs ?? 0),
        context: oldest ? doing(census, oldest.pid) : null, waiters: queued, evidence: `${file} (holder, waiter where name='${name}')`,
        dead: dead.length ? { kind: 'pool', scope, pids: dead } : null };
    });
    return { rows, unavailable: unavailable.map(row => ({ surface: 'runner-unavailable', key: row.host, holder: row.host, pid: null,
      ageMs: Math.max(0, now - Date.parse(row.since)), detail: String(row.detail).slice(0, 240), waiters: [], evidence: `${file} (runner_unavailable)` })) };
  } catch { return { rows: [], unavailable: [] }; }
  finally { db.close(); }
}

/** Every Git directory of this repository: the main one and each linked worktree's. */
function gitDirectories(commonDir) {
  const dirs = [commonDir];
  try { for (const name of fs.list(join(commonDir, 'worktrees'))) dirs.push(join(commonDir, 'worktrees', name)); } catch { /* No linked worktrees. */ }
  return dirs;
}

/** Checkout writer records; a takeover's intent file is the waiter that a long writer blocks. */
export function readCheckoutWriters(commonDir, now, census) {
  const rows = [];
  for (const gitDir of gitDirectories(commonDir)) {
    const directory = join(gitDir, 'pullboard-checkout-writers');
    let names;
    try { names = fs.list(directory).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)); } catch { continue; }
    const intent = join(gitDir, 'pullboard-checkout-takeover');
    const intentAge = fileAge(intent, now);
    for (const name of names) {
      const file = join(directory, name);
      let record;
      try { record = JSON.parse(fs.readFile(file)); } catch { continue; }
      if (!Number.isSafeInteger(record?.pid) || !Number.isFinite(record?.at)) continue;
      const alive = pidAlive(record.pid);
      const command = doing(census, record.pid);
      rows.push({ surface: 'checkout-writer', key: `${gitDir}:${command?.split(' ').slice(2, 3).join('') || 'writer'}`,
        holder: `writer in ${gitDir}`, pid: record.pid, ageMs: Math.max(0, now - record.at), context: command,
        waiters: intentAge === null ? [] : [{ label: 'checkout takeover', pid: null, ageMs: intentAge }], evidence: file,
        dead: alive ? null : { kind: 'file', files: [file], pid: record.pid } });
    }
  }
  return rows;
}

/**
 * The board's writer markers: each is a writer holding or waiting for SQLite's write lock. The oldest live one is
 * the holder and the rest wait behind it; a marker of a gone pid is dead.
 */
export function readBoardWriters(boardFile, now, census) {
  let directory;
  try { directory = fs.realpath(boardFile) + '.write-holders'; } catch { return []; }
  let names;
  try { names = fs.list(directory).filter(name => /^\d+-[a-f0-9-]+\.json$/u.test(name)); } catch { return []; }
  const live = [], dead = [];
  for (const name of names) {
    const file = join(directory, name);
    let marker;
    try { marker = JSON.parse(fs.readFile(file)); } catch { continue; }
    if (!Number.isSafeInteger(marker?.pid) || !Number.isFinite(marker?.acquiredAt)) continue;
    const observed = census.get(marker.pid);
    // A reused pid whose start differs is not this writer: its marker is as dead as a gone pid's.
    if (!pidAlive(marker.pid) || (observed && marker.started && observed.started.replace(/\s+/gu, ' ') !== String(marker.started).replace(/\s+/gu, ' '))) { dead.push(file); continue; }
    live.push({ file, marker, ageMs: Math.max(0, now - marker.acquiredAt) });
  }
  live.sort((a, b) => b.ageMs - a.ageMs);
  const rows = [];
  if (live.length) {
    const [first, ...rest] = live;
    rows.push({ surface: 'board-write', key: `${boardFile}:${first.marker.command ?? 'unknown'}`,
      holder: `${first.marker.command ?? 'unknown'} by ${first.marker.seat ?? 'unknown'}`, pid: first.marker.pid, ageMs: first.ageMs,
      context: doing(census, first.marker.pid), evidence: first.file,
      waiters: rest.map(row => ({ label: `${row.marker.command ?? 'unknown'} by ${row.marker.seat ?? 'unknown'}`, pid: row.marker.pid, ageMs: row.ageMs, context: doing(census, row.marker.pid) })) });
  }
  if (dead.length) rows.push({ surface: 'board-write', key: `${boardFile}:dead`, holder: `${dead.length} dead writer marker${dead.length === 1 ? '' : 's'}`,
    pid: null, ageMs: 0, waiters: [], evidence: directory, dead: { kind: 'file', files: dead } });
  return rows;
}

/** A resource database's single-writer queue: writer.lock names the writer, every other entry waits in arrival order. */
export function readResourceWriteQueue(databaseFile, now, census) {
  const directory = `${databaseFile}.writes`;
  let names;
  try { names = fs.list(directory); } catch { return []; }
  const lock = join(directory, 'writer.lock');
  let writer = null;
  try {
    const text = fs.readFile(lock);
    const [pid, at] = text.split(' ').map(Number);
    if (Number.isSafeInteger(pid)) writer = { pid, ageMs: Number.isFinite(at) ? Math.max(0, now - at) : (fileAge(lock, now) ?? 0), text };
  } catch { /* No writer holds the queue. */ }
  const waiters = names.filter(name => /^\d{24}-/u.test(name)).map(name => {
    const pid = Number(name.split('-')[3]);
    return { label: name.split('-')[2] ?? 'write', pid, ageMs: fileAge(join(directory, name), now) ?? 0, context: doing(census, pid) };
  });
  if (!writer && !waiters.length) return [];
  const alive = writer ? pidAlive(writer.pid) : true;
  const command = writer ? doing(census, writer.pid) : null;
  return [{ surface: 'resource-write', key: `${databaseFile}:${command?.split(' ').slice(1, 3).join(' ') || 'queue'}`,
    holder: writer ? `${databaseFile.split('/').slice(-2).join('/')} writer` : `${databaseFile.split('/').slice(-2).join('/')} queue (no writer)`,
    pid: writer?.pid ?? null, ageMs: writer?.ageMs ?? Math.max(0, ...waiters.map(row => row.ageMs)), context: command, waiters, evidence: directory,
    dead: writer && !alive ? { kind: 'lock', file: lock, text: writer.text, pid: writer.pid } : null }];
}

/** The submit hand-off line: each place waits for a worker; a reserved place whose submitter died is dead. */
export function readHandoffQueue(queueDirectory, now, census) {
  let names;
  try { names = fs.list(queueDirectory).filter(name => /^\d+-.+\.(json|reserved)$/u.test(name)).sort(); } catch { return []; }
  if (!names.length) return [];
  const waiters = [], dead = [];
  for (const name of names) {
    const file = join(queueDirectory, name);
    let owner = null;
    try { owner = JSON.parse(fs.readFile(file)); } catch { /* A filled place may hold a request, not an owner. */ }
    const pid = Number.isSafeInteger(owner?.pid) ? owner.pid : null;
    if (name.endsWith('.reserved') && pid && !pidAlive(pid)) { dead.push(file); continue; }
    waiters.push({ label: name.replace(/\.(json|reserved)$/u, ''), pid, ageMs: fileAge(file, now) ?? 0, context: pid ? doing(census, pid) : null });
  }
  const oldest = waiters.reduce((most, row) => row.ageMs > (most?.ageMs ?? -1) ? row : most, null);
  return [{ surface: 'handoff-queue', key: 'submit-handoff-queue', holder: oldest ? `place ${oldest.label}` : 'dead reservations', pid: oldest?.pid ?? null,
    ageMs: oldest?.ageMs ?? 0, waiters, evidence: queueDirectory, dead: dead.length ? { kind: 'file', files: dead } : null }];
}

/** The newest span end per gate job, from today's and yesterday's span files. */
function lastSpanEnds(spanFolder, now) {
  const ends = new Map();
  for (const day of [now - 86_400_000, now]) {
    let text;
    try { text = fs.readFile(join(spanFolder, `${storeName(new Date(day).toISOString().slice(0, 10), '.jsonl')}`)); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const span = JSON.parse(line);
        const end = Date.parse(span.end);
        if (typeof span.job === 'string' && end > (ends.get(span.job) ?? 0)) ends.set(span.job, end);
      } catch { /* A torn line is skipped. */ }
    }
  }
  return ends;
}

/** The pid inside a lease owner such as `pid-35470` or `fallback:status:76214`, or null. */
function leaseOwnerPid(owner) {
  const match = /(?:^pid-|:)(\d{2,9})(?::|$)/u.exec(String(owner ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * In-flight gates (a live lease on a gate or gate-drive job) and landing runs. A gate's progress is its last step or
 * span, whichever is later; a landing run's age is since it started.
 */
export function readJobs(boardFile, spanFolder, now, census) {
  const board = readOnly(boardFile);
  if (!board) return [];
  // With runs_store on the job rows live in the runs file beside the board, read only; a missing runs file reads as no jobs [B2,#9014].
  const runsOn = board.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'runs_store'").get()?.meta_value === '1';
  const db = runsOn ? readOnly(runsFilePath(boardFile)) : board;
  if (runsOn) board.close();
  if (!db) return [];
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job'").get()) return [];
    const jobs = db.prepare(`SELECT job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created,
      (SELECT MAX(job_step_at) FROM job_step WHERE job_step_job = job_id) AS last_step
      FROM job WHERE job_kind IN ('gate', 'gate-drive', 'landing-run') AND job_lease_until > ?`).all(now);
    const spans = jobs.some(job => job.job_kind !== 'landing-run') ? lastSpanEnds(spanFolder, now) : new Map();
    return jobs.map(job => {
      const pid = leaseOwnerPid(job.job_lease_owner);
      const owner = pid ? (pidAlive(pid) ? 'alive' : 'gone') : 'unknown';
      if (job.job_kind === 'landing-run') {
        return { surface: 'landing-run', key: 'landing-run', holder: `${job.job_id} (${job.job_step})`, pid, ageMs: Math.max(0, now - job.job_created),
          context: pid ? doing(census, pid) : null, detail: `lease owner ${job.job_lease_owner} (${owner})`, waiters: [], evidence: `${boardFile} job '${job.job_id}'` };
      }
      const bare = job.job_id.replace(/^(?:gate-drive:|handoff-drive-)/u, '');
      // A runner holding a gate renews its lease every few seconds while the gate's own phases (static, cells, selection) run
      // with no step or span of their own, so the renewal is its progress; the runner-job row budgets how long it may run (#6724).
      const renewed = !pid && job.job_kind === 'gate' && job.job_lease_owner ? job.job_lease_until - LEASE_RENEW_WINDOW_MS : 0;
      const progress = Math.max(job.last_step ?? 0, spans.get(job.job_id) ?? 0, spans.get(bare) ?? 0, renewed) || job.job_created;
      return { surface: 'gate', key: `gate:#${job.job_item ?? '?'}:${job.job_kind}`, holder: `#${job.job_item ?? '?'} ${job.job_kind} ${job.job_step}`, pid,
        ageMs: Math.max(0, now - progress), context: pid ? doing(census, pid) : null,
        detail: `job ${job.job_id}; lease owner ${job.job_lease_owner} (${owner}); last progress ${new Date(progress).toISOString()}`,
        waiters: [], evidence: `${boardFile} job '${job.job_id}', ${spanFolder}` };
    });
  } catch { return []; }
  finally { db.close(); }
}

/**
 * Pullboard processes whose parent is gone: ppid 1, run from a temporary Pullboard folder, and holding no lease the
 * machine accounts for. A detached daemon that holds its pool (the hand-off dispatcher) or a landing run is exempt.
 */
export function readOrphans(census, accounted) {
  const rows = [];
  for (const row of census.values()) {
    if (row.ppid !== 1 || !/\/(?:T|tmp)\/pullboard-/u.test(row.command) || accounted.has(row.pid) || row.pid === process.pid) continue;
    const script = /\s(\/\S+\.m?js)(?:\s|$)/u.exec(row.command)?.[1] ?? null;
    rows.push({ surface: 'orphan', key: `orphan:${script ? script.split('/').slice(-2).join('/') : row.command.split(' ')[0]}`,
      holder: `pid ${row.pid} ${script ? script.split('/').slice(-1)[0] : 'process'}`, pid: row.pid, ageMs: row.ageMs,
      context: doing(census, row.pid), detail: script && !fs.exists(script) ? `its script ${script} is deleted` : 'parent gone (ppid 1)',
      waiters: [], evidence: `ps pid ${row.pid} started ${row.started}`, orphan: { pid: row.pid, started: row.started } });
  }
  return rows;
}

/** Parse one runner's ps and lsof output into its job rows: each runner worker, its job folder and its test. */
function runnerJobRows(host, text, now) {
  const [psText, cwdText = ''] = String(text).split('\n__CWD__\n');
  const processes = [];
  for (const line of psText.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), ageMs: elapsedMs(match[3]), command: match[4] });
  }
  const cwd = new Map();
  let pid = null;
  for (const line of cwdText.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) cwd.set(pid, line.slice(1));
  }
  const children = new Map();
  for (const row of processes) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const workers = processes.filter(row => /\/\.pullboard-runner\/runtime\/[^/]+\/src\/runner-worker\.js(?:\s|$)/u.test(row.command));
  return workers.map(worker => {
    const descendants = [], pending = [...(children.get(worker.pid) ?? [])];
    while (pending.length) { const next = pending.pop(); descendants.push(next); pending.push(...(children.get(next.pid) ?? [])); }
    const folder = descendants.map(row => /\/\.pullboard-runner\/jobs\/[^/]+/u.exec(cwd.get(row.pid) ?? row.command)?.[0]).find(Boolean) ?? null;
    // The script a job runs is a relative path, or one inside the job's checkout, that a descendant names last.
    const testFile = descendants.map(row => row.command.split(/\s+/u).filter(word => /\.[cm]?js$/u.test(word) && (word.startsWith('./') || word.includes('/checkout/'))).at(-1)
      ?.replace(/^.*\/checkout\//u, '')).find(Boolean) ?? null;
    const label = testFile ? testFile.split('/').slice(-2).join('/') : descendants.length ? `${descendants[0].command.split(' ')[0].split('/').at(-1)} without a script` : 'no job process';
    return { surface: 'runner-job', key: `${host}:${label}`, holder: `${host} worker ${worker.pid}: ${label}`, pid: worker.pid, ageMs: worker.ageMs ?? 0,
      context: testFile ?? null, detail: `${descendants.length} child process${descendants.length === 1 ? '' : 'es'}; job folder ${folder ? `~${folder}` : 'none'}${worker.ppid === 1 ? '; orphaned (ppid 1)' : ''}`,
      waiters: [], evidence: `ssh ${host} ps -p ${worker.pid}`, host, working: descendants.length > 0 && worker.ppid !== 1 };
  });
}

/** The remote command: a ps of every process, then the cwd of each node process. */
const RUNNER_PS = 'ps -axo pid=,ppid=,etime=,command=; echo __CWD__; (command -v lsof >/dev/null 2>&1 && lsof -a -d cwd -Fpn -c node) 2>/dev/null; true';

/** Ask every runner over ssh at once, each bounded by timeoutMs; an unreachable runner is a note, not a breach. */
export async function readRunnerJobs(hosts, now, { timeoutMs = 800, exec = execFile } = {}) {
  const notes = [];
  const results = await Promise.all(hosts.map(host => new Promise(resolve => {
    exec('ssh', ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`, '-o', 'ClearAllForwardings=yes', '-T', host, RUNNER_PS],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error && !stdout) { notes.push(`${host}: not read (${error.killed ? 'timed out' : error.code ?? error.message})`); resolve([]); return; }
        resolve(runnerJobRows(host, stdout, now));
      });
  })));
  return { rows: results.flat(), notes };
}

/** The cwd of each named local pid, by one bounded lsof; a pid lsof cannot read is left out. */
function localCwds(pids) {
  const cwd = new Map();
  if (!pids.length) return cwd;
  const result = spawnSync('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], { encoding: 'utf8', timeout: 2_000,
    maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C' } });
  let pid = null;
  for (const line of String(result.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) cwd.set(pid, line.slice(1));
  }
  return cwd;
}

/** A shell loop that keeps running `pullboard heartbeat`: the shell itself, not one heartbeat run inside it. */
function heartbeatLoops(census) {
  return [...census.values()].filter(row => /^(?:\S*\/)?(?:sh|bash|zsh|dash)\s/u.test(row.command) && /\bheartbeat\b/u.test(row.command)
    && /\b(?:while|until|for|sleep)\b/u.test(row.command));
}

/** Resolve a path to its real form for comparison; an unresolvable path compares as written. */
function real(path) {
  try { return fs.realpath(path); } catch { return path; }
}

/** The newest commit time in a worktree, in epoch ms, or 0 when Git cannot say. */
function lastCommitMs(path) {
  const result = spawnSync('git', ['-C', path, 'log', '-1', '--format=%ct'], { encoding: 'utf8', timeout: 1_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const seconds = Number(String(result.stdout ?? '').trim());
  return result.status === 0 && Number.isFinite(seconds) ? seconds * 1000 : 0;
}

/**
 * Claims whose only liveness is a heartbeat loop, and heartbeat loops orphaned or duplicated. A claim breaches when its
 * seat's heartbeat is fresh while its last real activity (any board event by the seat, or a commit in its worktree) is
 * older than the budget. A loop whose parent is gone (ppid 1, or a parent no longer running) is orphaned.
 *
 * Why: heartbeat loops kept claims alive after the agents that owned them died; `next` never handed those items on.
 */
export function readHeartbeatClaims(boardFile, now, census, { cwds = localCwds, commitMs = lastCommitMs } = {}) {
  const loops = heartbeatLoops(census);
  const loopCwd = cwds(loops.map(row => row.pid));
  const byPath = new Map();
  for (const row of loops) {
    if (!loopCwd.has(row.pid)) continue;
    const loop = { ...row, path: real(loopCwd.get(row.pid)), orphaned: row.ppid === 1 || !census.has(row.ppid) };
    byPath.set(loop.path, [...(byPath.get(loop.path) ?? []), loop]);
  }
  const rows = [], seats = new Map();
  const db = readOnly(boardFile);
  const presence = readOnly(`${boardFile}.presence.sqlite`);
  try {
    const claims = db ? db.prepare(`SELECT item_id, item_owner, agent_path FROM item JOIN agent ON agent_id = item_owner
      WHERE item_status = 'claimed' AND item_lease_until > ? AND item_owner <> 'coordinator'`).all(new Date(now).toISOString()) : [];
    const lastEvent = db?.prepare('SELECT MAX(event_at) AS at FROM event WHERE event_by = ?');
    const heartbeat = presence?.prepare('SELECT at FROM heartbeat WHERE seat = ?');
    for (const claim of claims) {
      const path = real(claim.agent_path);
      seats.set(path, claim.item_owner);
      const beat = Date.parse(heartbeat?.get(claim.item_owner)?.at ?? '');
      // Only a fresh heartbeat keeps a claim alive; without one the claim watchdog already releases it.
      if (!(now - beat < 300_000)) continue;
      const event = Date.parse(lastEvent.get(claim.item_owner)?.at ?? '') || 0;
      const activity = Math.max(event, commitMs(claim.agent_path));
      const seatLoops = byPath.get(path) ?? [];
      rows.push({ surface: 'heartbeat-claim', key: `heartbeat-claim:${claim.item_owner}`, holder: `#${claim.item_id} by ${claim.item_owner}`,
        pid: seatLoops[0]?.pid ?? null, ageMs: activity ? Math.max(0, now - activity) : Number.MAX_SAFE_INTEGER, context: seatLoops[0] ? doing(census, seatLoops[0].pid) : null,
        detail: `heartbeat ${new Date(beat).toISOString()}; last activity ${activity ? new Date(activity).toISOString() : 'never'}; ${seatLoops.length} heartbeat loop${seatLoops.length === 1 ? '' : 's'}${seatLoops.some(loop => loop.orphaned) ? ' (orphaned)' : ''}`,
        waiters: [], evidence: `${boardFile} item ${claim.item_id}; ${boardFile}.presence.sqlite heartbeat '${claim.item_owner}'`,
        heartbeat: { item: claim.item_id, seat: claim.item_owner, lastSeen: activity ? new Date(activity).toISOString() : null,
          loops: seatLoops.map(loop => ({ pid: loop.pid, started: loop.started, orphaned: loop.orphaned })) } });
    }
  } catch { /* An unreadable board or presence file has no claim rows. */ }
  finally { db?.close(); presence?.close(); }
  for (const [path, group] of byPath) {
    for (const [index, loop] of group.entries()) {
      if (!loop.orphaned && index === 0) continue;
      rows.push({ surface: 'heartbeat-loop', key: `heartbeat-loop:${seats.get(path) ?? path}`, holder: `pid ${loop.pid} heartbeat loop in ${seats.get(path) ?? path}`,
        pid: loop.pid, ageMs: loop.ageMs, context: doing(census, loop.pid), detail: loop.orphaned ? 'parent gone' : `duplicate: ${group.length} loops in this worktree`,
        waiters: [], evidence: `ps pid ${loop.pid} started ${loop.started}; cwd ${path}`, ...(loop.orphaned ? { orphan: { pid: loop.pid, started: loop.started } } : {}) });
    }
  }
  return rows;
}
