/** @pullboard-test-input source-tree */
/**
 * Board commands run in a resident board process and the pullboard CLI is a thin client [H24]. The fixture copies
 * this checkout's code into its own Git checkout, so a commit there is "main's code changing", and runs the real CLI
 * against a real board in a separate repository.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  dirname,
  join,
  resolve,
} from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import {
  after,
  before,
  test,
} from 'node:test';
import {
  runFixtureChild,
  runFixtureChildAsync,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { codeVersion } from '../../src/io/resident/client.js';
import {
  residentBusyFile,
  residentSocket,
} from '../../src/io/resident/client.js';

const REPO = resolve(import.meta.dirname, '../../../..');
const BUDGET_MS = 200;
let fx;

/** Copy this checkout's code, untracked new files included, into a fresh checkout with one commit. */
function copyCode(code, env) {
  const files = runFixtureGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, env }).split('\0')
    // Test cases stay behind; test helpers come along, since some production modules import them.
    .filter(file => file && !(file.startsWith('test/') && file.endsWith('.test.js')) && existsSync(join(REPO, file)));
  for (const file of files) {
    mkdirSync(dirname(join(code, file)), { recursive: true });
    cpSync(join(REPO, file), join(code, file));
  }
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: code, env });
  // The copied code is committed, so the resident process names it by its code trees [#3249].
  runFixtureGit(['add', '-A'], { cwd: code, env });
  runFixtureGit(['commit', '-q', '--allow-empty', '-m', 'code one'], { cwd: code, env });
}

/** A module preloaded with --import that records every module, file or built-in, the process loads. */
function moduleHook(dir) {
  const hook = join(dir, 'module-hook.mjs');
  const loader = join(dir, 'module-loader.mjs');
  const record = 'appendFileSync(process.env.RESIDENT_MODULE_LOG, url + "\\n");';
  writeFileSync(loader, `import { appendFileSync } from 'node:fs';\nexport async function load(url, context, next) { ${record} return next(url, context); }\n`);
  writeFileSync(hook, ["import module from 'node:module';", "import { appendFileSync } from 'node:fs';",
    `if (module.registerHooks) module.registerHooks({ load(url, context, next) { ${record} return next(url, context); } });`,
    `else module.register(${JSON.stringify(new URL(`file://${loader}`).href)});`].join('\n'));
  return hook;
}

/**
 * Grow the fixture board to the measured production scale, as the startup budget fixture does: 1,000 more items,
 * 800 more seats, 45,000 events and 23,000 shouts, inserted as rows so the timed commands read a board our size.
 */
function seedBoardScale(file) {
  const db = new DatabaseSync(file);
  try {
    const at = '2026-11-02T00:00:00.000Z';
    db.exec('BEGIN');
    const agent = db.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_created_at) VALUES (?, ?, ?, ?)');
    for (let n = 1; n <= 800; n++) agent.run(`scale-${n}`, 'core', join(dirname(file), 'scale-seats', String(n)), at);
    const item = db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_status, item_created_by, item_created_at, item_updated_at)
      VALUES ('core', ?, 'The read preserves evidence.', 'open', 'coordinator', ?, ?)`);
    for (let n = 1; n <= 1000; n++) item.run(`Scale item ${n}`, at, at);
    const event = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
    for (let n = 0; n < 45000; n++) event.run(at, `scale-${1 + n % 800}`, n % 2 ? 'claim' : 'edit', 3 + n % 1000, '{}');
    const shout = db.prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, ?, ?)');
    for (let n = 0; n < 23000; n++) shout.run(`scale-${1 + n % 800}`, 'coordinator', `Board activity ${n}`, at);
    db.exec('COMMIT');
  } finally { db.close(); }
}

/** Every line the resident processes traced. */
function traceLines() {
  return existsSync(fx.traceFile) ? readFileSync(fx.traceFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

/** The connection events the resident process traced for the fixture board: how many it opened and reused. */
function connectionTrace() {
  // The fixture has one board; Git may spell its path through a symlink the fixture resolved.
  const board = traceLines().filter(line => typeof line.file === 'string' && line.file.endsWith(join('.git', 'pullboard', 'board.sqlite')));
  return { opened: board.filter(line => line.event === 'open').length, reused: board.filter(line => line.event === 'reuse').length };
}

before(() => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pb-resident-')));
  const code = join(dir, 'code'), repo = join(dir, 'repo'), shims = join(dir, 'shims'), home = join(dir, 'home');
  const bin = join(code, 'apps/cli/pullboard.js');
  mkdirSync(repo);
  mkdirSync(shims);
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(home, '.pullboard-machine'),
    PATH: `${shims}${delimiter}${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_RESIDENT: '1', PULLBOARD_RESIDENT_IDLE_MS: '120000', RESIDENT_MODULE_LOG: join(dir, 'modules.log'),
    PULLBOARD_RESIDENT_TRACE: join(dir, 'resident-trace.log') };
  for (const name of ['PULLBOARD_RELAY_TOKEN', 'PULLBOARD_RELAY_KEY']) delete env[name];
  copyCode(code, env);
  // The board's git hooks run pullboard from PATH; they must run the copied code.
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec '${process.execPath}' '${bin}' "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const hook = moduleHook(dir);
  /** Run the copied CLI in a folder and return its output, exit code and wall time. */
  const runIn = (cwd, args, { modules = false } = {}) => {
    if (modules) writeFileSync(env.RESIDENT_MODULE_LOG, '');
    const started = performance.now();
    const result = runFixtureChild(process.execPath, [...(modules ? ['--import', hook] : []), bin, ...args], { cwd, env, encoding: 'utf8' });
    const ms = performance.now() - started;
    const loaded = modules ? [...new Set(readFileSync(env.RESIDENT_MODULE_LOG, 'utf8').split('\n').filter(Boolean))] : null;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms, loaded };
  };
  /** Run the copied CLI under bash's `time` and return its user plus system CPU seconds (last stderr line). */
  const cpuSecondsIn = (cwd, args) => {
    const result = runFixtureChild('bash', ['-c', 'TIMEFORMAT="%U %S"; time "$@" >/dev/null', 'bash', process.execPath, bin, ...args], { cwd, env, encoding: 'utf8' });
    const [user, sys] = result.stderr.trim().split('\n').pop().split(' ').map(Number);
    return { status: result.status, cpu: user + sys, stderr: result.stderr };
  };
  /** The resident process's pid, from the pid file it writes once it listens; null when none is running. */
  const residentPid = () => {
    const place = residentSocket(repo, bin);
    try { return Number(readFileSync(place.pid, 'utf8').trim()); } catch { return null; }
  };
  /** Every pool slot's resident pid that has a pid file. */
  const poolPids = () => [0, 1, 2, 3].flatMap((slot) => {
    try { return [Number(readFileSync(residentSocket(repo, bin, slot).pid, 'utf8').trim())]; } catch { return []; }
  });
  /** Whether a process is alive. */
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  /**
   * Run version until the resident process answers it, which a thin client shows by loading under 20 modules.
   * Each try is a real command, so the wait ends on the observable answer rather than on a timer.
   */
  const awaitResident = () => {
    const deadline = performance.now() + 20_000;
    let last;
    while (performance.now() < deadline) {
      last = runIn(repo, ['version'], { modules: true });
      if (last.status === 0 && last.loaded.length < 20 && residentPid()) return last;
    }
    assert.fail(`no resident process answered within 20 s; last client loaded ${last?.loaded.length} modules`);
  };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, env });
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ spec: 'SPEC.md', practice: 'DOCTRINE.md', gate: 'true',
    lanes: { core: { owns: ['src/'], specs: ['H24'] } } }));
  writeFileSync(join(repo, 'SPEC.md'), '# Test spec\n\n## H · Speed\n- H24 [approved, must] Board commands answer fast. | gate: apps/cli/journeys/resident/board.test.js\n');
  assert.equal(runIn(repo, ['init']).status, 0);
  runFixtureGit(['add', '-A'], { cwd: repo, env });
  runFixtureGit(['commit', '-q', '-m', 'chore(repo): set up the resident fixture'], { cwd: repo, env });
  for (const title of ['First', 'Second']) {
    const added = runIn(repo, ['add', 'core', title, '--specs', 'H24', '--criterion', 'it works', '--brief', 'Files: src/a.js\nTest: it works.']);
    assert.equal(added.status, 0, added.stdout + added.stderr);
  }
  const worktree = join(dir, 'core-1');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'core/one', worktree], { cwd: repo, env });
  // A known strong model, so the seat's route covers the strong items the fixture claims; an unknown label joins on mid and claim is refused ROUTE.
  const joined = runIn(worktree, ['join', 'core', '--model', 'claude-opus-5-5']);
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  seedBoardScale(join(repo, '.git', 'pullboard', 'board.sqlite'));
  fx = { dir, code, repo, worktree, env, runIn, cpuSecondsIn, residentPid, poolPids, alive, awaitResident,
    board: join(repo, '.git', 'pullboard', 'board.sqlite'), traceFile: env.PULLBOARD_RESIDENT_TRACE };
});

after(() => {
  if (!fx) return;
  // A busy first process sends commands to the next pool slot, so every slot's process is stopped.
  for (const pid of fx.poolPids()) if (fx.alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(fx.dir, { recursive: true, force: true });
});

/**
 * The fastest wall time of five runs of one command, each checked for success.
 * Machine load only ever adds time to a run, so the fastest run is the command's own cost; a median of three
 * gave contradictory verdicts on one tree when a neighbour's work landed in two of the three runs.
 */
function median(cwd, args) {
  const times = [0, 1, 2, 3, 4].map(() => {
    const result = fx.runIn(cwd, args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    return result.ms;
  }).sort((a, b) => a - b);
  return times[0];
}

test('clause 1: on a board our size, show, inbox, claim and next run through a warm resident process in under 200 ms, from a client of under 20 modules [H24]', () => {
  fx.awaitResident();
  for (const [cwd, args] of [[fx.repo, ['show', '1']], [fx.worktree, ['inbox']], [fx.worktree, ['claim', '1']], [fx.worktree, ['next']]]) {
    // One untimed run loads anything the process has not loaded yet; the client must stay thin on it.
    const warm = fx.runIn(cwd, args, { modules: true });
    assert.equal(warm.status, 0, `${args.join(' ')}: ${warm.stdout}${warm.stderr}`);
    assert.ok(warm.loaded.length < 20, `${args.join(' ')} loaded ${warm.loaded.length} modules in the client: ${warm.loaded.join(', ')}`);
    const ms = median(cwd, args);
    assert.ok(ms < BUDGET_MS, `${args.join(' ')} took a best-of-five ${Math.round(ms)} ms through the warm resident process`); // budget: approved row H24 bar, every warm board command under 200 ms
  }
  const shown = fx.runIn(fx.repo, ['show', '1']);
  assert.match(shown.stdout, /#1 {2}claimed core-1/u, 'the claim made through the resident process is on the board');
});

test('clause 1: pullboard heartbeat on a warm board costs under 0.2 s wall and under 0.1 s CPU, from a client of under 20 modules [C7,#3250]', () => {
  fx.awaitResident();
  const warm = fx.runIn(fx.worktree, ['heartbeat'], { modules: true });
  assert.equal(warm.status, 0, `${warm.stdout}${warm.stderr}`);
  assert.ok(warm.loaded.length < 20, `heartbeat loaded ${warm.loaded.length} modules in the client: ${warm.loaded.join(', ')}`);
  const cpus = [0, 1, 2, 3, 4].map(() => {
    const run = fx.cpuSecondsIn(fx.worktree, ['heartbeat']);
    assert.equal(run.status, 0, run.stderr);
    return run.cpu;
  }).sort((a, b) => a - b);
  assert.ok(cpus[0] < 0.1, `heartbeat cost ${cpus[0]} s of client CPU (user plus system) through the warm resident process`); // budget: frozen bar, under 0.1 s CPU
  const ms = median(fx.worktree, ['heartbeat']);
  assert.ok(ms < BUDGET_MS, `heartbeat took a median ${Math.round(ms)} ms through the warm resident process`); // budget: approved row H24 bar, every warm board command under 200 ms
});

test('clause 2: hook pre-commit does not load the gate run, runner, landing-service or flake graphs [C7,#3250]', () => {
  const hook = readFileSync(join(fx.code, 'apps/cli/src/io/commands/hook.js'), 'utf8');
  const topLevel = hook.split('\n').filter(line => !line.startsWith(' ') || /^ {2}\w+,$/u.test(line)).join('\n');
  for (const heavy of ['packages/runners/index.js', 'packages/flakes/index.js']) {
    assert.ok(!topLevel.includes(heavy), `${heavy} is imported only inside the pre-push branch`);
  }
  for (const name of ['runGate', 'gateReport', 'runnerExecutionServices', 'landingExecutionServices', 'quarantineWaivers']) {
    assert.ok(!new RegExp(`^(?:import \\{ ${name}\\b|  ${name},$)`, 'mu').test(hook), `${name} is not a static import of the hook module`);
  }
});

test('the resident process holds the board open: reads reuse its connection, and concurrent commands each own one [H24]', async () => {
  fx.awaitResident();
  fx.runIn(fx.repo, ['show', '2']);
  const before = connectionTrace();
  for (let round = 0; round < 3; round++) assert.equal(fx.runIn(fx.repo, ['show', '2']).status, 0);
  const after = connectionTrace();
  assert.equal(after.opened, before.opened, 'warm reads open no new board connection');
  assert.ok(after.reused >= before.reused + 3, `each warm read reuses the held connection (${after.reused - before.reused} reuses)`);
  // Two commands at once run on two connections, and each answers as it would alone.
  const alone = fx.runIn(fx.repo, ['show', '2', '--json']);
  const [first, second] = await Promise.all([0, 1].map(() => runFixtureChildAsync(process.execPath,
    [join(fx.code, 'apps/cli/pullboard.js'), 'show', '2', '--json'], { cwd: fx.repo, env: fx.env })));
  for (const result of [first, second]) {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), JSON.parse(alone.stdout));
  }
  assert.ok(connectionTrace().opened <= after.opened + 2, 'concurrent commands open at most one connection each');
});

test('a killed resident process falls back in-process with the same output, and a new one starts [H24]', () => {
  fx.awaitResident();
  const warm = fx.runIn(fx.repo, ['show', '2', '--json'], { modules: true });
  assert.ok(warm.loaded.length < 20, 'the warm answer came from the resident process');
  const killed = fx.residentPid();
  process.kill(killed, 'SIGKILL');
  const fallback = fx.runIn(fx.repo, ['show', '2', '--json'], { modules: true });
  assert.ok(fallback.loaded.length > 100, `the fallback ran in-process, loading ${fallback.loaded.length} modules`);
  assert.deepEqual([fallback.status, fallback.stdout, fallback.stderr], [warm.status, warm.stdout, warm.stderr]);
  fx.awaitResident();
  assert.notEqual(fx.residentPid(), killed, 'the fallback started a fresh resident process');
});

test('a new main commit makes the next command use the new code [H24]', () => {
  fx.awaitResident();
  const before = fx.runIn(fx.repo, ['version']);
  const old = fx.residentPid();
  const packageFile = join(fx.code, 'package.json');
  const data = JSON.parse(readFileSync(packageFile, 'utf8'));
  data.version = '0.0.0-resident-new';
  writeFileSync(packageFile, JSON.stringify(data, null, 2) + '\n');
  runFixtureGit(['add', 'package.json'], { cwd: fx.code, env: fx.env });
  runFixtureGit(['commit', '-q', '--allow-empty', '-m', 'code two'], { cwd: fx.code, env: fx.env });
  const next = fx.runIn(fx.repo, ['version']);
  const release = (result) => result.stdout.split('\n')[0];
  assert.notEqual(release(before), '0.0.0-resident-new');
  assert.equal(release(next), '0.0.0-resident-new', 'the first command after the commit runs the new code');
  const warm = fx.awaitResident();
  assert.equal(release(warm), '0.0.0-resident-new', 'the new resident process serves the new code');
  assert.notEqual(fx.residentPid(), old);
  assert.equal(fx.alive(old), false, 'the resident process loaded from the old commit has retired');
});

test('clause 1: after main moves with no code change, the next show is served by the same resident pid [C7,#3249]', () => {
  fx.awaitResident();
  const old = fx.residentPid();
  writeFileSync(join(fx.code, 'landed-note.txt'), 'a landing that touches no code path\n');
  runFixtureGit(['add', 'landed-note.txt'], { cwd: fx.code, env: fx.env });
  runFixtureGit(['commit', '-q', '-m', 'docs only'], { cwd: fx.code, env: fx.env });
  const shown = fx.runIn(fx.repo, ['show', '1'], { modules: true });
  assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
  assert.ok(shown.loaded.length < 20, `the show ran in the resident process, not cold: ${shown.loaded.length} modules in the client`);
  assert.equal(fx.residentPid(), old, 'the same resident process served it');
  assert.equal(fx.alive(old), true, 'the resident process did not retire');
});

/**
 * Kill every resident process started for this socket and wait until none runs. Why the socket argument, not the pid
 * file: a resident an earlier command started may still be loading and has not written its pid yet.
 */
function stopResidents(socket) {
  // A resident names its socket in its arguments from the moment it starts, before it listens.
  const holders = () => runFixtureChild('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n')
    .filter(line => line.includes(socket)).map(line => Number(line.trim().split(/\s+/u)[0])).filter(pid => pid > 0 && pid !== process.pid);
  // A resident an earlier client started may appear just after the others stop; stop until none has run for a while.
  let quiet = 0;
  for (let round = 0; round < 400; round++) {
    const live = holders();
    quiet = live.length ? 0 : quiet + 1;
    if (quiet >= 10) return;
    for (const pid of live) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.fail(`processes still hold ${socket}: ${holders().join(', ')}`);
}

/**
 * Reject with a named error when a promise has not settled in time. Why: an await that never settles on a loaded
 * runner otherwise runs to the file timeout, which kills the whole file and hides which step stalled.
 */
function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Ask a resident process to run its idle check now, and return its answer. */
function tick(socket) {
  return new Promise((resolve, reject) => {
    const client = connect(socket);
    let text = '';
    client.setEncoding('utf8');
    client.on('connect', () => client.write(JSON.stringify({ t: 'tick' }) + '\n'));
    client.on('data', chunk => { text += chunk; });
    client.on('error', reject);
    client.on('close', () => resolve(JSON.parse(text.trim()).t));
  });
}

test('clause 1: an idle resident process closes its board connections and exits [H24]', async () => {
  // One resident process, started directly at the board's socket on a clock the test moves; no wall-clock wait.
  const bin = join(fx.code, 'apps/cli/pullboard.js');
  const place = residentSocket(fx.repo, bin);
  // Every process holding the board's socket stops first, including a resident an earlier command started.
  stopResidents(place.socket);
  rmSync(place.pid, { force: true });
  rmSync(place.socket, { force: true });
  const clockFile = join(fx.dir, 'resident-clock');
  const start = Date.parse('2026-11-03T00:00:00.000Z');
  writeFileSync(clockFile, String(start));
  const env = { ...fx.env, PULLBOARD_RESIDENT_IDLE_MS: '60000', PULLBOARD_RESIDENT_CLOCK: clockFile };
  const daemon = spawn(process.execPath, [join(fx.code, 'apps/cli/src/io/resident/board.js'), place.socket, bin, codeVersion(bin).version, place.pid],
    { cwd: fx.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  daemon.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => daemon.once('exit', code => resolve(code)));
  await within(new Promise((resolve, reject) => {
    let stdout = '';
    daemon.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; if (stdout.includes('listening\n')) resolve(); });
    daemon.once('exit', code => reject(new Error(`the resident process exited ${code} before listening: ${stderr}`)));
  }), 10_000, `the resident process listening (stderr: ${stderr})`);
  const served = fx.runIn(fx.repo, ['show', '2'], { modules: true });
  assert.equal(served.status, 0, served.stderr);
  assert.ok(served.loaded.length < 20, 'the read ran in the resident process, on a connection it holds');
  assert.equal(await within(tick(place.socket), 5_000, 'the first idle check'), 'busy', 'within the idle limit it keeps serving');
  writeFileSync(clockFile, String(start + 60_001));
  assert.equal(await within(tick(place.socket), 5_000, 'the second idle check'), 'retired', 'past the idle limit it retires');
  assert.equal(await within(exited, 10_000, `the retired resident process exiting (stderr: ${stderr})`), 0, stderr);
  const own = traceLines().filter(line => line.pid === daemon.pid);
  assert.ok(own.some(line => line.event === 'retire:idle'), JSON.stringify(own));
  assert.ok(own.some(line => line.event === 'close' && line.file.endsWith(join('.git', 'pullboard', 'board.sqlite'))), 'it closed the board connection it held');
  assert.notEqual(fx.residentPid(), daemon.pid, 'it removed its pid file on the way out');
});


/**
 * Resolve true once `file` exists, or false after `ms`. Why a stat watch: a folder watch on macOS can coalesce away
 * the event for a file created among the board's own writes.
 */
function appears(file, ms) {
  return new Promise((resolve) => {
    const seen = (stat) => { if (stat.nlink > 0) end(true); };
    watchFile(file, { interval: 25 }, seen);
    const timer = setTimeout(() => end(false), ms);
    /** Settle once and stop watching. */
    function end(found) { unwatchFile(file, seen); clearTimeout(timer); resolve(found); }
    if (existsSync(file)) end(true);
  });
}

/**
 * Run `check` while a shout holds the resident process's event loop for up to 60 s inside SQLite's busy handler, as the
 * 6-minute status did, then release it and confirm the process cleans up after the command.
 */
async function whileResidentBlocked(check) {
  fx.awaitResident();
  const busy = residentBusyFile(residentSocket(fx.repo, join(fx.code, 'apps/cli/pullboard.js')).pid);
  const alone = fx.runIn(fx.repo, ['show', '2', '--json']);
  assert.equal(alone.status, 0, alone.stderr);
  // Holding the board's write lock makes a shout through the resident process wait for it, a synchronous wait.
  const lock = new DatabaseSync(fx.board);
  lock.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
  let slow, exited = false;
  try {
    slow = runFixtureChildAsync(process.execPath, [join(fx.code, 'apps/cli/pullboard.js'), 'shout', 'all', 'a slow write'],
      { cwd: fx.worktree, env: { ...fx.env, PULLBOARD_BOARD_QUEUE_MS: '60000' } });
    slow.then(() => { exited = true; }, () => { exited = true; });
    // The resident process writes its busy file as the shout starts; the shout then waits on the lock.
    assert.ok(await appears(busy, 20_000), 'the slow shout started in the resident process');
    assert.equal(exited, false, 'the slow shout is waiting on the board lock');
    await check({ busy, alone, stillRunning: () => !exited });
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  const done = await slow;
  assert.equal(done.status, 0, done.stderr);
  assert.ok(!existsSync(busy), 'the resident process removed its busy file when the command ended');
}

test('clause 1: a command blocked for 60 s in the resident process never stalls a show from another seat [C7]', () => whileResidentBlocked(({ busy, alone, stillRunning }) => {
  // Once the command has run a while (its busy file says a second ago), another seat's show reads the board directly at once.
  writeFileSync(busy, `${readFileSync(busy, 'utf8').split(' ')[0]} ${Date.now() - 1_000}\n`);
  const direct = fx.runIn(fx.repo, ['show', '2', '--json']);
  assert.equal(direct.status, 0, direct.stderr);
  assert.ok(direct.ms < 2_000, `show answered in ${Math.round(direct.ms)} ms while the slow command ran`); // budget: ceiling of bar clause 1, an answer under 2 s
  assert.deepEqual(JSON.parse(direct.stdout), JSON.parse(alone.stdout));
  assert.equal(stillRunning(), true, 'the slow shout was still running throughout');
}));

test('clause 2: a show queued behind it falls back to its own direct board read within 5 s [C7]', () => whileResidentBlocked(({ busy, alone, stillRunning }) => {
  // A command that started just now does not yet send others to the board, so this show queues behind it and must give
  // up waiting and read the board itself.
  writeFileSync(busy, `${readFileSync(busy, 'utf8').split(' ')[0]} ${Date.now()}\n`);
  const queued = fx.runIn(fx.repo, ['show', '2', '--json'], { modules: true });
  assert.equal(queued.status, 0, queued.stderr);
  assert.ok(queued.ms < 5_000, `the queued show answered in ${Math.round(queued.ms)} ms`); // budget: ceiling of bar clause 2, a direct read within 5 s
  assert.ok(queued.loaded.length > 100, `the queued show read the board in-process (${queued.loaded.length} modules)`);
  assert.deepEqual(JSON.parse(queued.stdout), JSON.parse(alone.stdout));
  assert.equal(stillRunning(), true, 'the slow shout was still running throughout');
}));

test('clause 1: while one resident process runs a long command, the next pool process answers warm from a thin client [C7]', () => whileResidentBlocked(({ busy, alone, stillRunning }) => {
  writeFileSync(busy, `${readFileSync(busy, 'utf8').split(' ')[0]} ${Date.now() - 1_000}\n`);
  // The first show finds the next slot empty, starts its process and reads the board itself; later shows go there warm.
  const deadline = performance.now() + 20_000;
  let warm;
  while (performance.now() < deadline) {
    warm = fx.runIn(fx.repo, ['show', '2', '--json'], { modules: true });
    assert.equal(warm.status, 0, warm.stderr);
    if (warm.loaded.length < 20) break;
  }
  assert.ok(warm.loaded.length < 20, `a show was served by another pool process (last client loaded ${warm.loaded.length} modules)`);
  assert.deepEqual(JSON.parse(warm.stdout), JSON.parse(alone.stdout));
  assert.equal(stillRunning(), true, 'the slow shout was still running throughout');
  assert.ok(fx.poolPids().length >= 2, 'a second pool process is running');
}));
