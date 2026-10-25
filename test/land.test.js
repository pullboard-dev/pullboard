/** Exercise landing against real private Git worktrees, hooks, SQLite and bare remotes [B3,R3]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { landingFailures, landingSubject } from '../src/land.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { startFixtureChild, runFixtureChild } from './fixture-child.js';
import { waitForFixtureProgress } from './fixture-progress.js';
import { assertNoRemoteLanding } from './land-no-remote-fixture.js';
import { MARKER_NOT_YET, readMarker } from './land-marker-fixture.js';
import { assertLandingStopIdentity } from './land-stop-fixture.js';
import { assertLandingDoctrineCounts } from './land-doctrine-fixture.js';
import {
  onBoard,
  events,
  calls,
  json,
  mergeSubjects,
  childOutcome,
} from './land-board-fixture.js';
import { landingTimeoutFixture } from './landing-timeout-fixture.js';
import { assertParallelLanding, assertParallelCliLease, assertParallelNestedGate } from './land-parallel-fixture.js';
import { landEnginesInOrder } from './land-engine-fixture.js';
import {
  assertCollisionFreeLanding,
  assertSiblingConflictLanding,
  assertDeferredLandingPriority,
} from './land-collision-fixture.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, waitFor, BIN } = e2e;
const FILES = [1, 2, 3, 4].map((n) => `web/land-${n}.test.js`);

test('a landing stop never signals a reused process group [Q1,Q3,C7]', async () => {
  await assertLandingStopIdentity();
});

test('a landing records a falling doctrine count and holds a rising count [B3,R3,D1,D3]', () => {
  assertLandingDoctrineCounts({ landProject, itemWorktree, submitItem, acceptItem });
});

test('a repo with no remote lands into the local trunk and status reads as normal [I1,B3,R3,H5]', () => {
  assertNoRemoteLanding(sandbox, commitFile);
});
/** Start a separate process holding an exclusive write transaction on the fixture board. */
function startExclusiveBoardWriter(box, boardFile, name) {
  const ready = join(box.dir, `${name}-ready`);
  const release = join(box.dir, `${name}-release`);
  const released = join(box.dir, `${name}-released`);
  const source = [
    "const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite');",
    'const [file, ready, release, released] = process.argv.slice(1);',
    'const db = new DatabaseSync(file);',
    "try { const journal = db.prepare('PRAGMA journal_mode = DELETE').get().journal_mode;",
    "const locking = db.prepare('PRAGMA locking_mode = EXCLUSIVE').get().locking_mode;",
    "if (journal !== 'delete' || locking !== 'exclusive') throw new Error('fixture did not acquire rollback-journal exclusive mode');",
    "db.exec('BEGIN EXCLUSIVE'); db.exec('CREATE TABLE IF NOT EXISTS fixture_write (value INTEGER)'); db.exec('INSERT INTO fixture_write (value) VALUES (1)');",
    'fs.writeFileSync(ready, JSON.stringify({ journal, locking })); const deadline = Date.now() + 20_000;',
    'while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    "if (!fs.existsSync(release)) throw new Error('writer release was not received');",
    "db.exec('COMMIT'); db.close(); fs.writeFileSync(released, 'released');",
    "} catch (error) { try { db.close(); } catch {} process.stderr.write(error.stack + '\\n'); process.exitCode = 1; }",
  ].join('\n');
  const child = startFixtureChild(process.execPath, ['-e', source, boardFile, ready, release, released], {
    cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  return { child, closed: childOutcome(child), ready, release, released };
}
/** Run the real pre-commit hook with a preload observing its agentAt SQLite read. */
function startHookRead(box, probe, marker) {
  const env = { ...box.env, HOOK_READ_ATTEMPT: marker };
  const child = startFixtureChild(process.execPath, ['--import', probe, BIN, 'hook', 'pre-commit'], {
    cwd: box.web, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { child.stdoutText += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { child.stderrText += part; });
  child.closed = childOutcome(child);
  return child;
}

/** Emit real failing TAP and a separate single-file runner, recording every invocation. */
function gateFixture(box) {
  const gate = join(box.dir, 'land-gate.cjs');
  const checks = join(box.dir, 'land-check.cjs');
  const callPath = join(box.dir, 'land-gate-calls.jsonl');
  const hold = join(box.dir, 'hold');
  const entered = join(box.dir, 'entered');
  const release = join(box.dir, 'release');
  const trace = join(box.dir, 'gate-trace.jsonl');
  writeFileSync(gate, [
    "const fs = require('node:fs'); const path = require('node:path');",
    `const calls = ${JSON.stringify(callPath)}; const hold = ${JSON.stringify(hold)}; const entered = ${JSON.stringify(entered)}; const release = ${JSON.stringify(release)}; const trace = ${JSON.stringify(trace)};`,
    "const root = process.cwd(); const args = process.argv.slice(2); fs.appendFileSync(calls, JSON.stringify(args) + '\\n');",
    "const alone = args.includes('--alone'); const web = path.join(root, 'web'); const files = alone ? args.filter(a => a !== '--alone') : (fs.existsSync(web) ? fs.readdirSync(web).filter(n => /^land-\\d+\\.test\\.js$/.test(n)).map(n => 'web/' + n) : []);",
    "fs.appendFileSync(trace, JSON.stringify({ alone, files }) + '\\n'); const fullRuns = fs.readFileSync(trace, 'utf8').trim().split('\\n').map(line => JSON.parse(line)).filter(row => !row.alone).length;",
    "if (!alone && fs.existsSync(hold) && (fs.readFileSync(hold, 'utf8') === 'armed' || Number(fs.readFileSync(hold, 'utf8')) === fullRuns)) { fs.writeFileSync(entered, root); const end = Date.now() + 20000; while (!fs.existsSync(release) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); if (!fs.existsSync(release)) process.exit(24); }",
    "console.log('TAP version 13'); let failed = 0;",
    "files.forEach((file, i) => { const text = fs.readFileSync(path.resolve(root, file), 'utf8'); const red = process.env.LAND_SUPPRESS_RED !== '1' && (text.includes('RED') || !alone && text.includes('FLAKE')); const name = (/NAME:(\\S+)/.exec(text) || [])[1] || file + ' keeps the landed behavior'; console.log('# Subtest: ' + name); console.log((red ? 'not ok ' : 'ok ') + (i + 1) + ' - ' + name); if (red) { failed++; console.log('  ---'); console.log('  location: ' + path.resolve(root, file) + ':1:1'); console.log('  failureType: testCodeFailure'); console.log('  error: fixture behavior is red'); console.log('  ...'); } });",
    "console.log('1..' + files.length); console.log('# tests ' + files.length); console.log('# pass ' + (files.length - failed)); console.log('# fail ' + failed); process.exitCode = failed ? 1 : 0;",
  ].join('\n'));
  writeFileSync(checks, "const fs = require('node:fs'); const file = process.argv[2]; if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').trim()) process.exit(1);\n");
  return { gate: `node ${JSON.stringify(gate)}`, affected: `node ${JSON.stringify(gate)} --alone`, checks, calls: callPath, hold, entered, release, trace };
}

/** Create a private initialized project with a real bare origin and active hooks. */
function landProject() {
  const box = sandbox();
  const commands = gateFixture(box);
  const fixture = project(commands.gate, box);
  const path = join(fixture.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.affectedTests = commands.affected;
  writeFileSync(path, JSON.stringify(config, null, 2));
  fixture.git(fixture.repo, 'add', 'pullboard.json');
  fixture.git(fixture.repo, 'commit', '-q', '-m', 'chore: configure landing');
  fixture.git(fixture.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  fixture.git(box.dir, 'init', '-q', '--bare', remote);
  fixture.git(fixture.repo, 'remote', 'add', 'origin', remote);
  const pushed = fixture.tryGit(fixture.repo, 'push', '-q', '-u', 'origin', 'main');
  assert.equal(pushed.status, 0, pushed.stderr);
  return { ...fixture, ...commands, remote };
}

test('a hook read waits for another process\'s lock [C7,B3]', { timeout: 40_000 }, // budget: hang-only ceiling covers the real writer, hook and fixture cleanup; no speed claim.
async (t) => {
  const box = landProject();
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const probe = join(box.dir, 'observe-hook-read.mjs');
  const marker = join(box.dir, 'hook-read-attempted');
  writeFileSync(probe, [
    "import { writeFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const prepare = DatabaseSync.prototype.prepare;',
    'DatabaseSync.prototype.prepare = function (sql, ...args) {',
    "  if (String(sql) !== 'SELECT * FROM agent WHERE agent_path = ?') return Reflect.apply(prepare, this, [sql, ...args]);",
    "  writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'prepare-started' }));",
    '  try {',
    '    const statement = Reflect.apply(prepare, this, [sql, ...args]);',
    '    const get = statement.get;',
    '    statement.get = function (...values) {',
    "      writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'get-started' }));",
    '      try { return Reflect.apply(get, this, values); }',
    "      catch (error) { writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'error', code: error.code ?? null, errcode: error.errcode ?? null, message: error.message })); throw error; }",
    '    };',
    '    return statement;',
    "  } catch (error) { writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'error', code: error.code ?? null, errcode: error.errcode ?? null, message: error.message })); throw error; }",
    '};',
  ].join('\n'));
  const writers = [];
  const hooks = [];
  t.after(async () => {
    const settle = async (promise, timeoutMs) => {
      let timer;
      try { return await Promise.race([promise, new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    };
    for (const writer of writers) {
      writeFileSync(writer.release, 'release');
      if (!await settle(writer.closed, 1_000) && writer.child.exitCode === null && writer.child.signalCode === null) {
        try { process.kill(-writer.child.pid, 'SIGTERM'); } catch {}
        if (!await settle(writer.closed, 1_000) && writer.child.exitCode === null && writer.child.signalCode === null) {
          try { process.kill(-writer.child.pid, 'SIGKILL'); } catch {}
          await writer.closed;
        }
      }
    }
    for (const hook of hooks) {
      if (!await settle(hook.closed, 1_000) && hook.exitCode === null && hook.signalCode === null) {
        hook.kill('SIGTERM');
        if (!await settle(hook.closed, 1_000) && hook.exitCode === null && hook.signalCode === null) {
          hook.kill('SIGKILL');
          await hook.closed;
        }
      }
    }
  });

  const writer = startExclusiveBoardWriter(box, boardFile, 'hook-read');
  writers.push(writer);
  await waitFor(() => existsSync(writer.ready), 'exclusive rollback-journal writer');
  assert.deepEqual(JSON.parse(readFileSync(writer.ready, 'utf8')), { journal: 'delete', locking: 'exclusive' });
  const hook = startHookRead(box, probe, marker);
  hooks.push(hook);
  await waitFor(() => existsSync(marker), 'hook agentAt query attempt');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const observation = JSON.parse(readFileSync(marker, 'utf8'));
  const sqliteBusy = observation.code === 'SQLITE_BUSY' || ((observation.errcode ?? 0) & 0xff) === 5;
  assert.equal(sqliteBusy, false, `hookRead must wait for the released lock, not return SQLITE_BUSY: ${JSON.stringify(observation)} ${hook.stderrText}`);
  assert.ok(['prepare-started', 'get-started'].includes(observation.phase), `hook reached its native SQLite read: ${JSON.stringify(observation)}`);
  assert.equal(hook.exitCode, null, `hook read remains pending during the real exclusive writer: ${hook.stderrText}`);
  writeFileSync(writer.release, 'release');
  const [writerResult, hookResult] = await Promise.all([writer.closed, hook.closed]);
  assert.equal(writerResult.error, null, `exclusive writer spawned: ${writerResult.error?.message ?? ''}`);
  assert.deepEqual({ code: writerResult.code, signal: writerResult.signal }, { code: 0, signal: null }, writer.child.fixtureFailure ?? 'exclusive writer commits and closes');
  assert.equal(hookResult.error, null, `hook child spawned: ${hookResult.error?.message ?? ''}`);
  assert.deepEqual({ code: hookResult.code, signal: hookResult.signal }, { code: 0, signal: null }, hook.stderrText);
  assert.ok(existsSync(writer.released), 'writer releases its lock after commit and close');
});

test('a staged approved-row hook read waits for another process\'s lock [C7,B3,S19]', { timeout: 40_000 }, // budget: hang-only ceiling covers native Git, the exclusive writer and fixture cleanup; no speed claim.
async (t) => {
  const box = landProject();
  const specPath = join(box.repo, 'SPEC.md');
  writeFileSync(specPath, readFileSync(specPath, 'utf8').replace('The page renders.', 'The changed page renders.'));
  box.git(box.repo, 'add', 'SPEC.md');
  const before = box.git(box.repo, 'rev-parse', 'HEAD');
  const staged = box.git(box.repo, 'write-tree');
  const control = box.tryGit(box.repo, 'commit', '-m', 'feat: change approved promise [G1]');
  assert.equal(control.status, 1, control.stderr);
  assert.match(control.stderr, /G1 changes approved text without the person's exact approval/);

  const marker = join(box.dir, 'approved-read-attempted');
  const probe = join(box.dir, 'observe-approved-read.mjs');
  const ready = join(box.dir, 'approved-read-ready');
  writeFileSync(probe, [
    "import { existsSync, renameSync, writeFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    '/** Publish a complete marker atomically so readers never see a truncated destination. */',
    'const publish = (value) => { const target = process.env.APPROVED_READ_MARKER; const temporary = `${target}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, target); };',
    'const prepare = DatabaseSync.prototype.prepare;',
    'DatabaseSync.prototype.prepare = function (sql, ...args) {',
    "  if (String(sql) !== 'SELECT meta_value FROM board_meta WHERE meta_key=?') return Reflect.apply(prepare, this, [sql, ...args]);",
    "  publish({ phase: 'before-lock' });",
    '  const deadline = Date.now() + 8000;',
    '  while (!existsSync(process.env.APPROVED_READ_READY) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    "  if (!existsSync(process.env.APPROVED_READ_READY)) throw new Error('exclusive writer did not become ready');",
    "  publish({ phase: 'read-started' });",
    '  try { return Reflect.apply(prepare, this, [sql, ...args]); }',
    "  catch (error) { publish({ phase: 'error', code: error.code ?? null, errcode: error.errcode ?? null, message: error.message }); throw error; }",
    '};',
  ].join('\n'));
  let writer;
  let hook;
  t.after(async () => {
    if (writer) {
      writeFileSync(writer.release, 'release');
      await writer.closed;
    }
    if (hook && hook.exitCode === null && hook.signalCode === null) {
      hook.kill('SIGKILL');
      await hook.closed;
    }
  });
  hook = startFixtureChild('git', ['commit', '-m', 'feat: change approved promise [G1]'], {
    cwd: box.repo, env: { ...box.env, NODE_OPTIONS: `--import=${probe}`, APPROVED_READ_MARKER: marker, APPROVED_READ_READY: ready },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hook.stderrText = '';
  hook.stdout.resume();
  hook.stderr.setEncoding('utf8').on('data', (part) => { hook.stderrText += part; });
  hook.closed = childOutcome(hook);
  await waitFor(() => readMarker(marker) !== MARKER_NOT_YET, 'native staged-approval hook query');
  assert.equal(readMarker(marker).phase, 'before-lock');
  writer = startExclusiveBoardWriter(box, join(box.repo, '.git', 'pullboard', 'board.sqlite'), 'approved-read');
  await waitFor(() => existsSync(writer.ready), 'approved-row exclusive writer');
  await waitFor(() => {
    const observation = readMarker(marker);
    return observation !== MARKER_NOT_YET && observation.phase !== 'before-lock';
  }, 'approved-row read under the exclusive lock');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const observation = readMarker(marker);
  const sqliteBusy = observation.code === 'SQLITE_BUSY' || ((observation.errcode ?? 0) & 0xff) === 5;
  assert.equal(sqliteBusy, false, `staged approval read must wait, not return SQLITE_BUSY: ${JSON.stringify(observation)} ${hook.stderrText}`);
  assert.equal(observation.phase, 'read-started');
  assert.equal(hook.exitCode, null, `native hook remains pending during the writer: ${hook.stderrText}`);
  writeFileSync(writer.release, 'release');
  const [writerResult, hookResult] = await Promise.all([writer.closed, hook.closed]);
  assert.deepEqual({ code: writerResult.code, signal: writerResult.signal }, { code: 0, signal: null }, writer.child.fixtureFailure);
  assert.deepEqual({ code: hookResult.code, signal: hookResult.signal }, { code: 1, signal: null }, hook.stderrText);
  assert.match(hook.stderrText, /G1 changes approved text without the person's exact approval/);
  assert.doesNotMatch(hook.stderrText, /database is locked|restore valid staged SSH trust files/);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), before, 'normal approval refusal leaves the commit unchanged');
  assert.equal(box.git(box.repo, 'write-tree'), staged, 'the staged approved-row change remains available for person approval');
});

test('a half-written hook-read marker is read as not yet written [C7,B3,S19]', { timeout: 40_000 }, // budget: hang-only ceiling covers the real hook and its fixture cleanup.
async (t) => {
  const box = landProject();
  const specPath = join(box.repo, 'SPEC.md');
  writeFileSync(specPath, readFileSync(specPath, 'utf8').replace('The page renders.', 'The changed page renders.'));
  box.git(box.repo, 'add', 'SPEC.md');
  const marker = join(box.dir, 'half-written-hook-read');
  const ready = join(box.dir, 'half-written-hook-read-ready');
  const release = join(box.dir, 'half-written-hook-read-release');
  const probe = join(box.dir, 'observe-half-written-hook-read.mjs');
  writeFileSync(probe, [
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const prepare = DatabaseSync.prototype.prepare;',
    'DatabaseSync.prototype.prepare = function (sql, ...args) {',
    "  if (String(sql) !== 'SELECT meta_value FROM board_meta WHERE meta_key=?') return Reflect.apply(prepare, this, [sql, ...args]);",
    "  writeFileSync(process.env.APPROVED_READ_MARKER, '{\"phase\":', { mode: 0o600 });",
    "  writeFileSync(process.env.APPROVED_READ_READY, 'ready', { mode: 0o600 });",
    '  const deadline = Date.now() + 8000;',
    '  while (!existsSync(process.env.APPROVED_READ_RELEASE) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    "  if (!existsSync(process.env.APPROVED_READ_RELEASE)) throw new Error('hook marker release was not received');",
    "  appendFileSync(process.env.APPROVED_READ_MARKER, '\"before-lock\"}');",
    '  return Reflect.apply(prepare, this, [sql, ...args]);',
    '};',
  ].join('\n'));
  let hook;
  t.after(async () => {
    writeFileSync(release, 'release', { mode: 0o600 });
    if (hook && hook.exitCode === null && hook.signalCode === null) {
      await Promise.race([hook.closed, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000))]);
      if (hook.exitCode === null && hook.signalCode === null) {
        hook.kill('SIGTERM');
        await Promise.race([hook.closed, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000))]);
        if (hook.exitCode === null && hook.signalCode === null) { hook.kill('SIGKILL'); await hook.closed; }
      }
    }
  });
  hook = startFixtureChild('git', ['commit', '-m', 'feat: change approved promise [G1]'], {
    cwd: box.repo,
    env: { ...box.env, NODE_OPTIONS: `--import=${probe}`, APPROVED_READ_MARKER: marker, APPROVED_READ_READY: ready, APPROVED_READ_RELEASE: release },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hook.stderrText = '';
  hook.stdout.resume();
  hook.stderr.setEncoding('utf8').on('data', (part) => { hook.stderrText += part; });
  hook.closed = childOutcome(hook);
  await waitFor(() => existsSync(ready), 'native hook probe paused mid-write');
  assert.doesNotThrow(() => readMarker(marker), 'a partial marker is an unpublished observation, not a test error');
  assert.equal(readMarker(marker), MARKER_NOT_YET);
  writeFileSync(release, 'release', { mode: 0o600 });
  const result = await hook.closed;
  assert.equal(result.error, null, `native Git hook child spawned: ${result.error?.message ?? ''}`);
  assert.equal(result.code, 1, hook.stderrText);
  assert.match(hook.stderrText, /G1 changes approved text without the person's exact approval/);
  assert.deepEqual(readMarker(marker), { phase: 'before-lock' }, 'the probe publishes a complete marker after release');
});

/** Give one private item a distinct canonical lane identity and an independent main base. */
function itemWorktree(box, number, file = FILES[number - 1], afterIds = []) {
  const path = join(box.dir, `land-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/land-${number}`, path, 'main');
  assert.equal(box.run(path, 'join', 'web').code, 0);
  const added = box.run(box.repo, 'add', 'web', `Land fixture ${number}`, '--specs', 'G1', '--criterion', `land fixture ${number} remains valid`,
    '--check', `node ${JSON.stringify(box.checks)} ${JSON.stringify(file)}`, ...(afterIds.length ? ['--after', afterIds.join(',')] : []), '--json');
  assert.equal(added.code, 0, added.err);
  const item = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(path, 'claim', String(item)).code, 0);
  return { path, item, file };
}

/** Build and submit a private fixture through its real hooks and item check. */
function submitItem(box, entry, contents = 'PASS\n') {
  const committed = commitFile(box, entry.path, entry.file, contents, `feat(web): build land fixture ${entry.item} [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  entry.commit = box.git(entry.path, 'rev-parse', 'HEAD');
  const submitted = box.run(entry.path, 'submit', String(entry.item));
  assert.equal(submitted.code, 0, submitted.err);
  return entry;
}

/** Verify only private fixture items at their actual submitted commits. */
function acceptItem(box, entry) {
  entry.reviewedTrunk = box.git(box.repo, 'rev-parse', 'main');
  box.git(box.repo, 'switch', '-q', '--detach', entry.commit);
  try {
    const verdict = box.run(box.repo, 'verify', String(entry.item), 'accept', '--as', 'coordinator', '--note', 'private landing fixture check passed');
    assert.equal(verdict.code, 0, verdict.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}

/** Prepare four independent submitted items and accept them in a caller-selected verdict order. */
function verifiedFour(box, { red, flaky, order = [0, 1, 2, 3] } = {}) {
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.map((file, index) => itemWorktree(box, index + 1, file));
  for (const [index, entry] of entries.entries()) submitItem(box, entry, index === red ? 'RED\n' : (Array.isArray(flaky) ? flaky.includes(index) : index === flaky) ? 'FLAKE\n' : 'PASS\n');
  for (const index of order) acceptItem(box, entries[index]);
  delete box.env.LAND_SUPPRESS_RED;
  return entries;
}

/**
 * Start a separate process holding a rollback-journal exclusive write on a private board.
 * @param {any} box
 * @param {string} boardFile
 * @param {string} name
 * @returns {{ child: any, closed: Promise<{code: number|null, signal: string|null, error: Error|null}>, ready: string, release: string, released: string }}
 */
function startExclusiveWriter(box, boardFile, name) {
  const ready = join(box.dir, `${name}-ready`);
  const release = join(box.dir, `${name}-release`);
  const released = join(box.dir, `${name}-released`);
  const source = [
    "const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite');",
    'const [file, ready, release, released, ownerPid] = process.argv.slice(1); const owner = Number(ownerPid);',
    'const db = new DatabaseSync(file);',
    "try { const journal = db.prepare('PRAGMA journal_mode = DELETE').get().journal_mode;",
    "const locking = db.prepare('PRAGMA locking_mode = EXCLUSIVE').get().locking_mode;",
    "if (journal !== 'delete' || locking !== 'exclusive') throw new Error('fixture did not acquire rollback-journal exclusive mode');",
    "db.exec('BEGIN EXCLUSIVE'); db.exec('CREATE TABLE IF NOT EXISTS fixture_write (value INTEGER)'); db.exec('INSERT INTO fixture_write (value) VALUES (1)');",
    'fs.writeFileSync(ready, JSON.stringify({ journal, locking, lockedAt: Date.now(), pid: process.pid }));',
    // Only the owning test releases the lock; an abandoned owner must not leave an orphan writer.
    'while (!fs.existsSync(release)) {',
    "  try { process.kill(owner, 0); } catch (error) { if (error.code === 'ESRCH') throw new Error('writer owner exited before release'); if (error.code !== 'EPERM') throw error; }",
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    '}',
    "const commitAt = Date.now(); db.exec('COMMIT'); db.close(); fs.writeFileSync(released, JSON.stringify({ commitAt, releasedAt: Date.now(), pid: process.pid }));",
    '} catch (error) { try { db.close(); } catch {} process.stderr.write(error.stack + \'\\n\'); process.exitCode = 1; }',
  ].join('\n');
  const child = startFixtureChild(process.execPath, ['-e', source, boardFile, ready, release, released, String(process.pid)], {
    cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.once('exit', (code, signal) => { child.writerExit = { observedAt: Date.now(), code, signal }; });
  const closed = lockChildOutcome(child);
  return { name, child, closed, ready, release, released };
}

/** Resolve when an owned child closes or fails to spawn, whichever happens first. */
function lockChildOutcome(child) {
  return new Promise((resolveOutcome) => {
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolveOutcome({ code, signal, error: spawnError }));
  });
}

/**
 * Launch the real hook command with the read-attempt preload and collect its terminal output.
 * @param {any} box
 * @param {string} probe
 * @param {string} marker
 * @returns {any}
 */
function launchHookProbe(box, probe, marker) {
  const env = { ...box.env, HOOK_READ_ATTEMPT: marker };
  const hookTiming = { launchRequestedAt: Date.now(), marker };
  const child = startFixtureChild(process.execPath, ['--import', probe, BIN, 'hook', 'pre-commit'], {
    cwd: box.web, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.hookTiming = hookTiming;
  child.once('spawn', () => { hookTiming.spawnObservedAt = Date.now(); });
  child.once('error', (error) => { hookTiming.spawnErrorObservedAt = Date.now(); hookTiming.spawnError = error.message; });
  child.once('exit', (code, signal) => { hookTiming.exitObservedAt = Date.now(); hookTiming.code = code; hookTiming.signal = signal; });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { child.stdoutText += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { child.stderrText += part; });
  child.closed = lockChildOutcome(child);
  return child;
}

test('land pushes one exact batch in verdict order and records each first-containing merge once [B3,R3]', () => {
  const box = landProject();
  const entries = verifiedFour(box, { order: [3, 1, 0, 2] });
  const base = box.git(box.repo, 'rev-parse', 'main');
  const start = calls(box).length;
  const result = json(box, box.repo, 'land', '--max', '4');
  const order = [3, 1, 0, 2].map((index) => entries[index].item);
  assert.deepEqual(result.landed, order);
  assert.deepEqual(mergeSubjects(box, base, result.batch.tip), [4, 2, 1, 3].map((n) => `chore(merge): land fixture ${n} [G1]`));
  assert.equal(result.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip, 'real pre-push accepted the gated tip');
  assert.ok(relative(join(box.repo, '.git', 'pullboard'), result.batch.root).startsWith('landings/'));
  assert.notEqual(result.batch.root, box.repo);
  assert.deepEqual(calls(box).slice(start), [[]], 'one full batch gate; pre-push reads its exact green tree stamp');
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of order.entries()) assert.equal(json(box, box.repo, 'show', String(id)).item_merged_commit, merges[index]);
  for (const [index, id] of order.entries()) assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', merges[index]).trim(), `Pullboard-Item: #${id}`, 'each train merge body is only its item trailer, naming no lane branch');
  const receipt = events(box).filter((event) => event.event_kind === 'main-moved');
  assert.equal(receipt.length, 1);
  assert.equal(JSON.parse(receipt[0].event_detail).sha, result.batch.tip);
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).id, result.batch.id);
  const eventCount = events(box).length;
  assert.deepEqual(json(box, box.repo, 'land').landed, []);
  assert.equal(events(box).length, eventCount, 'second invocation writes no duplicate receipts');
  assert.deepEqual(calls(box).slice(start), [[]], 'second invocation runs no tests');
  const lane = box.run(entries[0].path, 'land', '--json');
  assert.equal(JSON.parse(lane.out).error?.code, 'COORDINATOR_ONLY');
});

test('a train merge body is only the item trailer even when the local Git config logs merges [B3,R3]', () => {
  const box = landProject();
  verifiedFour(box, { order: [0, 1, 2, 3] });
  const base = box.git(box.repo, 'rev-parse', 'main');
  box.git(box.repo, 'config', 'merge.log', 'true');
  const result = json(box, box.repo, 'land', '--max', '4');
  assert.equal(result.landed.length, 4);
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of result.landed.entries()) {
    assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', merges[index]).trim(), `Pullboard-Item: #${id}`, 'merge.log=true appends no shortlog to the body');
  }
});

test('land bisects a real red, blocks stale proof and refuses an unverified stack [B3,R3,E8]', () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.map((file, index) => itemWorktree(box, index + 1, file));
  for (const entry of entries.slice(0, 3)) submitItem(box, entry, entry === entries[2] ? 'RED\n' : 'PASS\n');
  const hidden = itemWorktree(box, 5, 'web/unverified.js');
  assert.equal(commitFile(box, hidden.path, hidden.file, 'unverified\n', 'feat(web): unverified ancestor [G1]').status, 0);
  const hiddenSha = box.git(hidden.path, 'rev-parse', 'HEAD');
  box.git(entries[3].path, 'merge', '--no-ff', hiddenSha, '-m', 'feat(web): include ancestor [G1]');
  submitItem(box, entries[3]);
  for (const entry of entries) acceptItem(box, entry);
  assert.equal(box.run(hidden.path, 'submit', String(hidden.item)).code, 0);
  delete box.env.LAND_SUPPRESS_RED;
  assert.equal(commitFile(box, box.repo, FILES[1], 'different main content\n', 'chore: create a merge conflict').status, 0);
  const base = box.git(box.repo, 'rev-parse', 'main');
  const beforeEvents = events(box).length;
  const beforeCalls = calls(box).length;
  const dry = json(box, box.repo, 'land', '--max', '4', '--dry-run');
  assert.deepEqual(dry.conflicts, [], 'main changed the reviewed path, so stale proof is blocked before attempting its merge');
  assert.deepEqual(dry.blocked, [
    { id: entries[1].item, code: 'STALE_VERDICT', file: FILES[1], commit: base,
      reviewedTrunk: entries[1].reviewedTrunk, main: base },
    { id: entries[3].item, code: 'STACKED_UNVERIFIED', stacked: hidden.item },
  ]);
  assert.equal(events(box).length, beforeEvents, 'dry run creates no board batch');
  assert.equal(calls(box).length, beforeCalls, 'dry run runs no gate');
  const result = json(box, box.repo, 'land', '--max', '4');
  assert.deepEqual(result.landed, [entries[0].item]);
  assert.deepEqual(result.conflicts, dry.conflicts);
  assert.deepEqual(result.blocked, dry.blocked);
  assert.deepEqual(result.culprits.map((entry) => entry.id), [entries[2].item]);
  const evidence = result.batch.invariantEvidence;
  assert.equal(evidence.version, 1);
  const failedGate = evidence.gates.find(gate => !gate.isGreen);
  assert.match(failedGate.commit, /^[a-f0-9]{40}$/u, 'the actual gate records its tested commit, not only a tree');
  assert.ok(failedGate.submissions.some(row => row.id === entries[2].item && row.commit === entries[2].commit));
  assert.ok(failedGate.failures.includes(FILES[2]));
  const diagnosis = evidence.diagnostics.find(row => row.test === FILES[2]);
  assert.equal(diagnosis.commit, failedGate.commit, 'the whole-file diagnosis names the exact original merge');
  assert.equal(diagnosis.isGreen, false);
  assert.equal(typeof diagnosis.wallMs, 'number', 'runtime is the real queued diagnostic execution wall');
  assert.ok(diagnosis.wallMs >= 0);
  assert.equal(result.culprits[0].tests[0].file, FILES[2]);
  assert.match(result.culprits[0].tests[0].name, /keeps the landed behavior/u);
  assert.ok(json(box, box.repo, 'show', String(entries[2].item)).thread.some((entry) => entry.type === 'fact' && entry.text.includes(FILES[2])));
  assert.deepEqual(calls(box).slice(beforeCalls), [[], ['--alone', FILES[2]], [], [], []],
    'one red batch, one diagnostic, two bisection gates, then the final tree: returning its culprit changes badge counts, so that different tree needs its own gate');
  assert.equal(json(box, box.repo, 'show', String(entries[0].item)).item_merged_commit, result.batch.tip);
  for (const entry of entries.slice(1)) assert.equal(json(box, box.repo, 'show', String(entry.item)).item_merged_commit, null);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
  assert.notEqual(result.batch.tip, base);
  const afterCalls = calls(box).length;
  const beforeEmptyEvents = events(box);
  const beforeEmptyLease = onBoard(box, board => store.landingLeaseState(board));
  const again = box.run(box.repo, 'land', '--json');
  assert.equal(again.code, 1, again.out + again.err);
  assert.equal(JSON.parse(again.out).error.code, 'STALE_VERDICT', 'an all-blocked queue refuses instead of suggesting an empty successful land');
  assert.deepEqual(events(box), beforeEmptyEvents, 'an idle all-blocked selection adds no lease events');
  assert.deepEqual(onBoard(box, board => store.landingLeaseState(board)), beforeEmptyLease, 'a stale refusal takes no lease');
  assert.equal(json(box, box.repo, 'show', String(entries[2].item)).item_status, 'open', 'the known red is returned to its builder and is no longer a verified landing candidate');
  assert.equal(calls(box).length, afterCalls, 'known unchanged red is not retried');
});

test('land names sibling conflicts whose reviews share the unchanged main [B3,R3,E8]', () => {
  assertSiblingConflictLanding({ landProject, itemWorktree, submitItem, acceptItem, json, file: FILES[0] });
});

/** Keep the complete private diagnostic refusal in a failing assertion before fixture cleanup deletes its logs. */
function diagnosticOutput(batch) {
  const directory = dirname(batch.logPath);
  return readdirSync(directory).filter(file => file.startsWith('diagnostic-') && file.endsWith('.log'))
    .map(file => readFileSync(join(directory, file), 'utf8')).join('\n');
}

test('land diagnostics inherit their browser gate lease [C7]', () => {
  const box = landProject();
  const marker = join(box.dir, 'land-diagnostic-lease.json');
  const inspector = join(box.dir, 'inspect-land-diagnostic-lease.mjs');
  const resourcesUrl = new URL('../src/resources.js', import.meta.url).href;
  writeFileSync(inspector, [
    "import { writeFileSync } from 'node:fs';",
    `import { inheritedGateSlot } from ${JSON.stringify(resourcesUrl)};`,
    "const lease = inheritedGateSlot({ root: process.cwd(), browser: true });",
    "if (!lease?.browser) throw new Error('focused diagnosis did not inherit its browser lease');",
    `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ file: process.argv[2], held: process.env.PULLBOARD_GATE_SLOT_HELD ?? '', pool: process.env.PULLBOARD_GATE_SLOT_POOL ?? '', token: process.env.PULLBOARD_GATE_SLOT_TOKEN ?? '', browser: process.env.PULLBOARD_BROWSER_SLOT_HELD ?? '', inheritedBrowser: lease.browser }));`,
  ].join('\n'));

  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.affectedTests = `node ${JSON.stringify(inspector)}`;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  const configCommit = box.tryGit(box.repo, 'commit', '-q', '-m', 'chore: inspect landing diagnostic lease');
  assert.equal(configCommit.status, 0, configCommit.stderr);
  const configPush = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(configPush.status, 0, configPush.stderr);

  const entry = itemWorktree(box, 1, FILES[0]);
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    submitItem(box, entry, 'RED\n');
    acceptItem(box, entry);
  } finally {
    delete box.env.LAND_SUPPRESS_RED;
  }
  const result = json(box, box.repo, 'land');
  assert.equal(result.batch.state, 'flaky', `the full gate is red while its isolated diagnosis passes: ${diagnosticOutput(result.batch)}`);
  assert.deepEqual(result.flakes.map(({ test: file }) => file), [FILES[0]]);
  const inherited = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(inherited.file, FILES[0]);
  assert.equal(inherited.held, '1');
  assert.ok(inherited.pool, 'the child names the machine resource pool');
  assert.ok(inherited.token, 'the child names the live gate lease token');
  assert.equal(inherited.browser, '1');
  assert.equal(inherited.inheritedBrowser, true);
});

test('land holds a flake without retries and person waivers cover every failure at the exact tree [B3,R3]', () => {
  const box = landProject();
  const entries = verifiedFour(box, { flaky: [0, 1] });
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  const start = calls(box).length;
  const held = json(box, box.repo, 'land');
  assert.deepEqual(held.landed, []);
  assert.equal(held.batch.state, 'flaky');
  assert.deepEqual(held.flakes.map((flake) => flake.test), FILES.slice(0, 2));
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]]);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), base);
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_FLAKE');
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'nothing retries');
  assert.equal(events(box).filter((event) => event.event_kind === 'landing_flake').length, 2);
  const flakeItem = json(box, box.repo, 'show', String(held.flakes.find((flake) => flake.test === FILES[1]).item));
  assert.match(flakeItem.item_title, /Flaky test: web\/land-2/u);
  box.env.CODEX_THREAD_ID = 'private-agent-waiver-attempt';
  const agentAttempt = box.run(box.repo, 'land', '--waive', FILES[1], '--until', '2099-01-01', '--reason', 'private fixture exception', '--json');
  assert.equal(JSON.parse(agentAttempt.out).error?.code, 'B26_PERSON_CHANNEL');
  delete box.env.CODEX_THREAD_ID;
  const waiver = json(box, box.repo, 'land', '--waive', FILES[1], '--until', '2099-01-01', '--reason', 'private fixture exception').waiver;
  assert.equal(waiver.by, 'person');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base, 'recording a waiver does not land');
  const partial = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(partial.out).error?.code, 'LAND_FLAKE', 'one waiver cannot cover the other failing test');
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'partial waiver permits no retry');
  const waiverZero = json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'second private fixture exception').waiver;
  const landed = json(box, box.repo, 'land');
  assert.deepEqual(landed.landed, entries.map((entry) => entry.item));
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'waiver uses the recorded full gate at the same exact tree without retrying');
  assert.deepEqual(landed.batch.proof.failures.map((failure) => failure.waiver), [waiverZero.id, waiver.id]);
  assert.equal(landed.batch.proof.tree, box.git(landed.batch.root, 'rev-parse', 'HEAD^{tree}'));
  assert.ok(onBoard(box, (board) => store.waivedLandingProof(board, landed.batch.proof.tree)));
  assert.equal(onBoard(box, (board) => store.waivedLandingProof(board, 'f'.repeat(40))), null, 'proof cannot cover another tree');
  const stamp = box.git(landed.batch.root, 'rev-parse', '--git-path', 'pullboard-gate-green');
  assert.ok(!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== landed.batch.proof.tree, 'red gate never writes an ordinary green stamp');
  const expired = { now: () => new Date('2099-01-02T00:00:00Z') };
  assert.equal(onBoard(box, (board) => store.waivedLandingProof(board, landed.batch.proof.tree), expired), null, 'every waiver must remain live');
  const event = events(box).find((entry) => entry.event_kind === 'landing_waiver');
  assert.equal(event.event_by, 'person');
  assert.equal(commitFile(box, box.repo, 'docs/after-land.md', 'new exact tree\n', 'chore: advance the private tree').status, 0);
  const laterTree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const beforeHook = calls(box).length;
  onBoard(box, (board) => {
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-hook-proof', test: FILES[1], until: '2000-01-02', reason: 'expired proof fixture' });
    store.recordLandingBatch(board, { agentId: 'coordinator', batch: { ...landed.batch, id: 'expired-hook-batch', state: 'ready',
      base: landed.batch.tip, tip: box.git(box.repo, 'rev-parse', 'HEAD'), revision: 0,
      proof: { tree: laterTree, failures: [{ file: FILES[0], name: FILES[0], waiver: waiverZero.id }, { file: FILES[1], name: FILES[1], waiver: 'expired-hook-proof' }] } } });
  }, { now: () => new Date('2000-01-01T00:00:00Z') });
  const hook = runFixtureChild(process.execPath, [BIN, 'hook', 'pre-push'], { cwd: box.repo, env: box.env, encoding: 'utf8',
    input: `refs/heads/main ${box.git(box.repo, 'rev-parse', 'HEAD')} refs/heads/main ${landed.batch.tip}\n` });
  assert.equal(hook.status, 1, hook.stdout);
  assert.match(hook.stderr, /expired or missing person waiver/u);
  assert.equal(calls(box).length, beforeHook, 'expired proof is refused without rerunning the red gate');
});

test('a waiver after an early-stopped gate runs the gate again [C7,V4]', async (t) => {
  for (const mode of ['early green', 'early red', 'unaccounted', 'complete']) await t.test(`${mode} keeps the exact landing proof [C7,V4]`, () => {
    const box = landProject();
    const gate = join(box.dir, 'land-gate.cjs');
    writeFileSync(gate, [
      "const fs = require('node:fs'); const path = require('node:path');",
      `const calls = ${JSON.stringify(box.calls)}; const trace = ${JSON.stringify(box.trace)};`,
      "const args = process.argv.slice(2); const alone = args.includes('--alone'); fs.appendFileSync(calls, JSON.stringify(args) + '\\n');",
      "const files = alone ? args.filter(arg => arg !== '--alone') : fs.readdirSync('web').filter(name => /^land-\\d+\\.test\\.js$/.test(name)).map(name => 'web/' + name);",
      "console.log('TAP version 13'); let count = 0; let failed = 0;",
      "for (const file of files) { const text = fs.readFileSync(file, 'utf8'); count++; fs.appendFileSync(trace, JSON.stringify({ alone, file }) + '\\n');",
      "  const red = !alone && process.env.LAND_SUPPRESS_RED !== '1' && text.includes('FLAKE');",
      "  console.log((red ? 'not ok ' : 'ok ') + count + ' - ' + file + ' keeps the landed behavior');",
      "  if (red) { failed++; console.log('  ---\\n  location: ' + path.resolve(file) + ':1:1\\n  error: fixture failure\\n  ...');",
      "    if (process.env.LAND_EARLY_STOP === '1') { console.error('Landing gate stopped early after ' + file + ': fixture failure'); console.error('Files not run: ' + files.slice(count).join(', ')); break; } }",
      "}",
      "if (process.env.LAND_UNACCOUNTED === '1' && failed) process.exit(1);",
      "console.log('1..' + count); console.log('# tests ' + count); console.log('# pass ' + (count - failed)); console.log('# fail ' + failed); process.exitCode = failed ? 1 : 0;",
    ].join('\n'));
    const entries = verifiedFour(box, { flaky: 0 });
    if (mode.startsWith('early')) box.env.LAND_EARLY_STOP = '1';
    if (mode === 'unaccounted') box.env.LAND_UNACCOUNTED = '1';
    const base = box.git(box.repo, 'rev-parse', 'HEAD');
    const held = json(box, box.repo, 'land');
    assert.equal(held.batch.state, 'flaky');
    assert.deepEqual(held.landed, []);
    const before = calls(box).length;
    const initial = readFileSync(held.batch.logPath, 'utf8');
    if (mode.startsWith('early')) {
      assert.match(initial, /Landing gate stopped early/u);
      assert.ok(initial.includes(`Files not run: ${FILES.slice(1).join(', ')}`));
      assert.doesNotMatch(initial, /ok 2 -/u, 'later files actually did not run');
    } else {
      assert.doesNotMatch(initial, /stopped early|Files not run/u);
      if (mode === 'unaccounted') assert.doesNotMatch(initial, /^# fail /mu, 'the interrupted account has no positive completion footer');
    }
    json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'private first failure exception');
    delete box.env.LAND_EARLY_STOP;
    delete box.env.LAND_UNACCOUNTED;
    if (mode === 'early green' || mode === 'unaccounted') box.env.LAND_SUPPRESS_RED = '1';
    const result = json(box, box.repo, 'land');
    if (mode === 'complete') {
      assert.equal(calls(box).length, before, 'a complete recorded gate is reused after its waiver');
      assert.deepEqual(result.landed, entries.map(entry => entry.item));
    } else {
      assert.deepEqual(calls(box).slice(before), [[]], 'exactly one fresh full gate runs after the waiver');
      const rerun = readFileSync(result.batch.logPath, 'utf8');
      assert.match(rerun, /ok 4 - web\/land-4/u, 'the fresh run reaches the previously untouched final file');
      assert.doesNotMatch(rerun, /stopped early|Files not run/u);
      if (mode === 'early green' || mode === 'unaccounted') {
        assert.match(rerun, /# fail 0/u);
        assert.deepEqual(result.landed, entries.map(entry => entry.item));
        assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
      } else {
        assert.match(rerun, /# fail 1/u);
        assert.deepEqual(result.landed, [], 'a fresh red gate cannot borrow the earlier waived partial proof');
        assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base);
        assert.equal(box.git(box.remote, 'rev-parse', 'main'), base);
      }
    }
  });
});

test('a waiver after an early-stopped gate runs the gate again with legacy oversized markers [C7,V4]', () => {
  const box = landProject();
  const gate = join(box.dir, 'land-gate.cjs');
  writeFileSync(gate, [
    "const fs = require('node:fs'); const path = require('node:path');",
    `const calls = ${JSON.stringify(box.calls)}; const trace = ${JSON.stringify(box.trace)};`,
    "const args = process.argv.slice(2); const alone = args.includes('--alone'); fs.appendFileSync(calls, JSON.stringify(args) + '\\n');",
    "const files = alone ? args.filter(arg => arg !== '--alone') : fs.readdirSync('web').filter(name => /^land-\\d+\\.test\\.js$/.test(name)).map(name => 'web/' + name);",
    "console.log('TAP version 13'); let count = 0; let failed = 0;",
    "for (const file of files) { const text = fs.readFileSync(file, 'utf8'); count++; fs.appendFileSync(trace, JSON.stringify({ alone, file }) + '\\n');",
    "  const red = !alone && process.env.LAND_SUPPRESS_RED !== '1' && text.includes('FLAKE');",
    "  console.log((red ? 'not ok ' : 'ok ') + count + ' - ' + file + ' keeps the landed behavior');",
    "  if (red) { failed++; console.log('  ---\\n  location: ' + path.resolve(file) + ':1:1\\n  error: fixture failure\\n  ...');",
    "    if (process.env.LAND_EARLY_STOP === '1') { console.error('Landing gate stopped early after ' + file + ': fixture failure' + ' '.repeat(300)); console.error('Files not run: ' + files.slice(count).join(', ') + ' '.repeat(300)); break; } }",
    "}",
    "console.log('1..' + count); console.log('# tests ' + count); console.log('# pass ' + (count - failed)); console.log('# fail ' + failed); process.exitCode = failed ? 1 : 0;",
  ].join('\n'));
  const entries = verifiedFour(box, { flaky: 0 });
  box.env.LAND_EARLY_STOP = '1';
  const held = json(box, box.repo, 'land');
  assert.equal(held.batch.state, 'flaky');
  assert.deepEqual(held.landed, []);
  onBoard(box, board => {
    const saved = store.landingBatches(board).find(batch => batch.id === held.batch.id);
    store.recordLandingBatch(board, { agentId: 'coordinator', revision: saved.revision,
      batch: { ...saved, gateResults: saved.gateResults.map(({ complete, requiresGreen, ...run }) => run) } });
  });
  const before = calls(box).length;
  const initial = readFileSync(held.batch.logPath, 'utf8');
  assert.ok(initial.split('\n').find(line => line.startsWith('Landing gate stopped early after ')).length > 256,
    'the early-stop marker exceeds the legacy reader line cap');
  assert.ok(initial.split('\n').find(line => line.startsWith('Files not run: ')).length > 256);
  assert.doesNotMatch(initial, /ok 2 -/u, 'later files actually did not run');
  json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'private first failure exception');
  delete box.env.LAND_EARLY_STOP;
  box.env.LAND_SUPPRESS_RED = '1';
  const result = json(box, box.repo, 'land');
  assert.deepEqual(calls(box).slice(before), [[]], 'exactly one fresh full gate runs after the waiver');
  const rerun = readFileSync(result.batch.logPath, 'utf8');
  assert.match(rerun, /ok 4 - web\/land-4/u, 'the fresh run reaches the previously untouched final file');
  assert.doesNotMatch(rerun, /stopped early|Files not run/u);
  assert.match(rerun, /# fail 0/u);
  assert.deepEqual(result.landed, entries.map(entry => entry.item));
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
});

test('land stops again with an expired waiver, and a changed test on main releases the held batch [B3,R3]', () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  assert.equal(commitFile(box, box.repo, FILES[0], 'FLAKE\n', 'chore: install a flaky fixture test').status, 0);
  const entry = itemWorktree(box, 1, 'web/feature.js');
  submitItem(box, entry);
  acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED;
  const held = json(box, box.repo, 'land');
  assert.equal(held.batch.state, 'flaky');
  const past = { now: () => new Date('2000-01-01T00:00:00Z') };
  onBoard(box, (board) => store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-example', test: FILES[0], until: '2000-01-02', reason: 'expired fixture approval' }), past);
  const start = calls(box).length;
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_FLAKE');
  assert.equal(calls(box).length, start, 'expired waiver authorizes no retry');
  assert.equal(commitFile(box, box.repo, FILES[0], 'PASS\n', 'chore: correct the flaky test').status, 0);
  const landed = json(box, box.repo, 'land');
  assert.deepEqual(landed.landed, [entry.item]);
  assert.notEqual(landed.batch.id, held.batch.id);
  assert.equal(landed.batch.proof.failures.length, 0);
  assert.deepEqual(calls(box).slice(start), [[]], 'corrected test is gated afresh');
});

test("a person's waiver lets a submit and a landing gate through only the waived test [B3,R3,C7]", () => {
  const box = landProject();
  const past = { now: () => new Date('2000-01-01T00:00:00Z') };
  const stampOf = (cwd) => {
    const stamp = join(cwd, box.git(cwd, 'rev-parse', '--git-path', 'pullboard-gate-green'));
    return existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null;
  };
  const waived = itemWorktree(box, 1);
  assert.equal(commitFile(box, waived.path, waived.file, 'RED\n', `feat(web): build land fixture ${waived.item} [G1]`).status, 0);
  const unwaived = box.run(waived.path, 'submit', String(waived.item), '--json');
  assert.equal(JSON.parse(unwaived.out).error?.code, 'GATE_RED', 'an unwaived failure refuses the submission');
  onBoard(box, (board) => {
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-submit', test: FILES[0], until: '2000-01-02', reason: 'expired submit fixture' });
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-landing', test: FILES[1], until: '2000-01-02', reason: 'expired landing fixture' });
  }, past);
  const expired = box.run(waived.path, 'submit', String(waived.item), '--json');
  assert.equal(JSON.parse(expired.out).error?.code, 'GATE_RED', 'an expired waiver covers nothing');
  assert.equal(JSON.parse(box.run(waived.path, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'agent attempt', '--json').out).error?.code, 'COORDINATOR_ONLY', 'an agent seat cannot waive');
  box.env.CLAUDECODE = '1';
  assert.equal(JSON.parse(box.run(box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'agent shell attempt', '--json').out).error?.code, 'B26_PERSON_CHANNEL', 'an agent shell in the main checkout cannot waive');
  delete box.env.CLAUDECODE;
  onBoard(box, (board) => {
    const attempt = { channel: 'terminal', id: 'agent-attempt', test: FILES[0], until: '2099-01-01', reason: 'agent attempt' };
    assert.throws(() => store.recordLandingWaiver(board, { ...attempt, agentId: 'coordinator' }), /LAND_PERSON_ONLY/u);
    assert.throws(() => store.recordLandingWaiver(board, { ...attempt, agentId: 'web-1' }), /LAND_PERSON_ONLY/u);
    assert.throws(() => store.recordLandingWaiver(board, { ...attempt, agentId: 'person', channel: 'api' }), /B26_PERSON_CHANNEL/u);
    assert.equal(store.landingWaiverFor(board, { file: FILES[0], name: FILES[0] }), null, 'no attempt recorded a live waiver');
  });
  const waiver = json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'private flaky fixture tracked elsewhere').waiver;
  const line = new RegExp(`waived: .*\\(${FILES[0].replaceAll('.', '\\.')}\\) by person waiver ${waiver.id} for file ${FILES[0].replaceAll('.', '\\.')}: private flaky fixture tracked elsewhere; expires 2099-01-01T00:00:00\\.000Z`, 'u');

  const mixed = itemWorktree(box, 2);
  assert.equal(commitFile(box, mixed.path, FILES[0], 'RED\n', `feat(web): build land fixture ${mixed.item} [G1]`).status, 0);
  assert.equal(commitFile(box, mixed.path, mixed.file, 'RED\n', `feat(web): build land fixture ${mixed.item} again [G1]`).status, 0);
  const partial = box.run(mixed.path, 'submit', String(mixed.item), '--json');
  assert.equal(JSON.parse(partial.out).error?.code, 'GATE_RED', 'a waiver for one test never passes another failure');
  assert.equal(json(box, box.repo, 'show', String(mixed.item)).item_status, 'claimed');

  const submitted = box.run(waived.path, 'submit', String(waived.item));
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  assert.match(submitted.out, line, 'the submission names the waiver, its reason and its expiry');
  assert.match(submitted.out, /waived, not green/u);
  assert.equal(json(box, box.repo, 'show', String(waived.item)).item_status, 'submitted');
  const facts = events(box).filter((event) => event.event_kind === 'fact' && event.item_id === waived.item).map((event) => JSON.parse(event.event_detail).text);
  assert.ok(facts.some((text) => /recorded as waived, not green/u.test(text) && line.test(text)), 'the waived submission is recorded on the item');
  assert.notEqual(stampOf(waived.path), box.git(waived.path, 'rev-parse', 'HEAD^{tree}'), 'a waived submission writes no green stamp');

  assert.equal(commitFile(box, box.repo, FILES[0], 'RED\n', 'chore: install a flaky fixture test').status, 0);
  const landing = box.run(box.repo, 'gate', '--landing');
  assert.equal(landing.code, 0, `${landing.err}\n${landing.out}`);
  assert.match(landing.out, line, 'the landing gate names the waiver, its reason and its expiry');
  assert.match(landing.out, /landing gate waived, not green/u);
  const landingJson = json(box, box.repo, 'gate', '--landing');
  assert.equal(landingJson.green, false, 'a waived landing gate is never reported green');
  assert.deepEqual(landingJson.waived.map((entry) => [entry.file, entry.waiver]), [[FILES[0], waiver.id]]);
  assert.notEqual(stampOf(box.repo), box.git(box.repo, 'rev-parse', 'HEAD^{tree}'), 'a waived landing gate writes no green stamp');

  // A separate stage that fails outside any test is never covered by a waiver for the test that also failed.
  const setup = join(box.dir, 'stage-setup.cjs');
  const runs = join(box.dir, 'stage-setup-runs');
  const broken = join(box.dir, 'stage-setup-broken');
  writeFileSync(setup, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(runs)}, 'x'); if (fs.existsSync(${JSON.stringify(broken)})) throw new Error('separate setup stage failed');\n`);
  const configPath = join(box.repo, 'pullboard.json');
  const original = readFileSync(configPath, 'utf8');
  const gateCommand = JSON.parse(original).gate;
  const setGate = (command, message) => {
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(original), gate: command }, null, 2));
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', message);
  };
  writeFileSync(broken, 'on\n');
  setGate(`${gateCommand}; node ${JSON.stringify(setup)}`, 'chore: run a separate setup stage after the tests');
  const staged = box.run(box.repo, 'gate', '--landing', '--json');
  assert.equal(readFileSync(runs, 'utf8').length, 1, 'the failing setup stage really ran');
  assert.equal(staged.code, 1, 'a waived test plus a separate failing stage refuses the landing gate');
  assert.equal(JSON.parse(staged.out).waived, undefined, 'a refused run names no waived failures');
  assert.doesNotMatch(staged.out, /waived, not green/u);
  const stagedItem = itemWorktree(box, 4);
  assert.equal(commitFile(box, stagedItem.path, stagedItem.file, 'PASS\n', `feat(web): build land fixture ${stagedItem.item} [G1]`).status, 0);
  const stagedSubmit = box.run(stagedItem.path, 'submit', String(stagedItem.item), '--json');
  assert.equal(JSON.parse(stagedSubmit.out).error?.code, 'GATE_RED', 'a waived test plus a separate failing stage refuses the submission');
  assert.equal(readFileSync(runs, 'utf8').length, 2, 'the submission ran the failing setup stage');
  assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === stagedItem.item), 'a refused submission records nothing as waived');
  rmSync(broken);
  setGate(`node ${JSON.stringify(setup)} && ${gateCommand}`, 'chore: run a passing setup stage before the tests');
  const passingStage = box.run(box.repo, 'gate', '--landing');
  assert.equal(passingStage.code, 0, `${passingStage.err}\n${passingStage.out}`);
  assert.match(passingStage.out, line, 'a passing stage leaves only the waived test to subtract');

  // A pipeline counts each component's own status: a healthy producer leaves only the waived test,
  // and a failing producer piped into the same waived TAP is its own unwaived red, at landing and at submit.
  const consumer = join(box.dir, 'pipeline-consumer.cjs');
  writeFileSync(consumer, `process.stdin.resume(); process.stdin.on('end', () => { const child = require('node:child_process').spawnSync(${JSON.stringify(gateCommand)}, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); process.exitCode = child.status ?? 125; });\n`);
  setGate(`node ${JSON.stringify(setup)} | node ${JSON.stringify(consumer)}`, 'chore: pipe a setup producer into the tests');
  // The same default shell as the gate must enforce pipefail before any pipeline can run.
  // An unsupported shell must refuse even when a person waived the test printed by its consumer.
  const supportsPipefail = runFixtureChild('set -o pipefail', { cwd: box.repo, env: box.env, shell: true }).status === 0;
  if (supportsPipefail) {
    const gateLog = () => readFileSync(join(box.repo, box.git(box.repo, 'rev-parse', '--git-path', 'pullboard-gate.log')), 'utf8');
    const healthyPipe = box.run(box.repo, 'gate', '--landing');
    assert.equal(healthyPipe.code, 0, `${healthyPipe.err}\n${healthyPipe.out}`);
    assert.match(healthyPipe.out, line, 'a healthy producer leaves only the waived test to subtract');
    writeFileSync(broken, 'on\n');
    const producerRuns = readFileSync(runs, 'utf8').length;
    const failingPipe = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(readFileSync(runs, 'utf8').length, producerRuns + 1, 'the failing producer really ran');
    assert.match(gateLog(), /Error: separate setup stage failed/u, 'the producer failed on its own');
    assert.match(gateLog(), /^# fail 1$/mu, 'the waived TAP after it is complete');
    assert.equal(failingPipe.code, 1, 'a failing producer piped into the waived tests refuses the landing gate');
    assert.equal(JSON.parse(failingPipe.out).waived, undefined, 'a refused pipeline names no waived failures');
    const pipeItem = itemWorktree(box, 3);
    assert.equal(commitFile(box, pipeItem.path, pipeItem.file, 'PASS\n', `feat(web): build land fixture ${pipeItem.item} [G1]`).status, 0);
    const failingPipeSubmit = box.run(pipeItem.path, 'submit', String(pipeItem.item), '--json');
    assert.equal(JSON.parse(failingPipeSubmit.out).error?.code, 'GATE_RED', 'a failing producer piped into the waived tests refuses the submission');
    assert.equal(readFileSync(runs, 'utf8').length, producerRuns + 2, 'the submission ran the failing producer');
    assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === pipeItem.item), 'a refused pipeline submission records nothing as waived');
    rmSync(broken);
    const healthyPipeSubmit = box.run(pipeItem.path, 'submit', String(pipeItem.item));
    assert.equal(healthyPipeSubmit.code, 0, `${healthyPipeSubmit.err}\n${healthyPipeSubmit.out}`);
    assert.match(healthyPipeSubmit.out, line, 'a healthy producer leaves only the waived test at submit');
    assert.match(healthyPipeSubmit.out, /waived, not green/u);

    // A failing component is credited only with the failures in its own output: a setup step that fails beside
    // a consumer forwarding the waived TAP is unexplained, and a TAP producer piped through cat explains itself.
    const forwarder = join(box.dir, 'pipeline-forwarder.cjs');
    writeFileSync(forwarder, `process.stdin.resume(); process.stdin.on('end', () => { const child = require('node:child_process').spawnSync(${JSON.stringify(gateCommand)}, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); process.exitCode = 0; });\n`);
    setGate(`node ${JSON.stringify(setup)} | node ${JSON.stringify(forwarder)}`, 'chore: forward the waived tests behind a setup producer');
    writeFileSync(broken, 'on\n');
    const forwardRuns = readFileSync(runs, 'utf8').length;
    const forwarded = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(readFileSync(runs, 'utf8').length, forwardRuns + 1, 'the failing setup producer really ran');
    assert.match(gateLog(), /Error: separate setup stage failed/u, 'the setup producer failed on its own');
    assert.match(gateLog(), /^# fail 1$/mu, 'the forwarded waived TAP is complete');
    assert.equal(forwarded.code, 1, 'a failing setup producer is not explained by a consumer forwarding the waived tests');
    assert.equal(JSON.parse(forwarded.out).waived, undefined, 'a forwarded account names no waived failures');
    const forwardItem = itemWorktree(box, 5, FILES[3]);
    assert.equal(commitFile(box, forwardItem.path, forwardItem.file, 'PASS\n', `feat(web): build land fixture ${forwardItem.item} [G1]`).status, 0);
    const forwardedSubmit = box.run(forwardItem.path, 'submit', String(forwardItem.item), '--json');
    assert.equal(JSON.parse(forwardedSubmit.out).error?.code, 'GATE_RED', 'a forwarded account refuses the submission');
    assert.equal(readFileSync(runs, 'utf8').length, forwardRuns + 2, 'the submission ran the failing setup producer');
    assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === forwardItem.item), 'a refused forwarded submission records nothing as waived');
    rmSync(broken);
    setGate(`${gateCommand} | cat`, 'chore: pipe the waived tests through cat');
    const throughCat = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(throughCat.code, 0, `${throughCat.err}\n${throughCat.out}`);
    assert.equal(JSON.parse(throughCat.out).green, false, 'a waived pipeline is never reported green');
    assert.deepEqual(JSON.parse(throughCat.out).waived.map((entry) => [entry.file, entry.waiver]), [[FILES[0], waiver.id]], 'the TAP producer explains its own failure');
    const catItem = itemWorktree(box, 6, FILES[3]);
    assert.equal(commitFile(box, catItem.path, catItem.file, 'PASS\n', `feat(web): build land fixture ${catItem.item} [G1]`).status, 0);
    const catSubmit = box.run(catItem.path, 'submit', String(catItem.item));
    assert.equal(catSubmit.code, 0, `${catSubmit.err}\n${catSubmit.out}`);
    assert.match(catSubmit.out, line, 'a TAP producer piped through cat is waived at submit');
    assert.match(catSubmit.out, /waived, not green/u);
  } else {
    const setupRuns = readFileSync(runs, 'utf8');
    const refusedLanding = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(refusedLanding.code, 1, 'a waiver never enables a pipeline without pipefail');
    const landingRefusal = JSON.parse(refusedLanding.out);
    assert.equal(landingRefusal.error?.code, 'PIPEFAIL_UNAVAILABLE');
    assert.equal(landingRefusal.waived, undefined, 'an unsupported pipeline names no waived failures');
    assert.doesNotMatch(refusedLanding.out, /waived, not green/u);
    assert.equal(readFileSync(runs, 'utf8'), setupRuns, 'an unsupported landing pipeline never starts');
    const refusedItem = itemWorktree(box, 3);
    assert.equal(commitFile(box, refusedItem.path, refusedItem.file, 'PASS\n', `feat(web): build land fixture ${refusedItem.item} [G1]`).status, 0);
    const refusedSubmit = box.run(refusedItem.path, 'submit', String(refusedItem.item), '--json');
    assert.equal(refusedSubmit.code, 1, 'a waiver never enables an unsupported submission pipeline');
    assert.equal(JSON.parse(refusedSubmit.out).error?.code, 'PIPEFAIL_UNAVAILABLE');
    assert.equal(readFileSync(runs, 'utf8'), setupRuns, 'an unsupported submission pipeline never starts');
    assert.equal(json(box, box.repo, 'show', String(refusedItem.item)).item_status, 'claimed');
    assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === refusedItem.item), 'an unsupported pipeline records nothing as waived');
  }

  // A real landing run does not stop early on a waived failure: every other file still runs, then the waiver subtracts it.
  const laterRan = join(box.dir, 'later-file-ran');
  const waivedFile = 'test/landing-waived.test.cjs';
  assert.equal(commitFile(box, box.repo, waivedFile, "require('node:test').test('a flaky landing check', () => { throw new Error('known flake'); });\n", 'chore: add a flaky landing test').status, 0);
  assert.equal(commitFile(box, box.repo, 'test/landing-later.test.cjs', `require('node:test').test('a later landing check', () => { require('node:fs').writeFileSync(${JSON.stringify(laterRan)}, 'ran'); });\n`, 'chore: add a later landing test').status, 0);
  setGate(`node ${JSON.stringify(join(dirname(BIN), 'run-tests.js'))} --test-concurrency=1 ${waivedFile} test/landing-later.test.cjs`, 'chore: gate with the real test runner');
  const stopped = box.run(box.repo, 'gate', '--landing');
  assert.equal(stopped.code, 1, 'an unwaived failure still stops a landing run');
  assert.match(`${stopped.out}\n${stopped.err}`, /stopped early/u);
  assert.ok(!existsSync(laterRan), 'the early stop skipped the later file');
  const runnerWaiver = json(box, box.repo, 'land', '--waive', waivedFile, '--until', '2099-01-01', '--reason', 'known landing flake').waiver;
  const continued = box.run(box.repo, 'gate', '--landing');
  assert.equal(continued.code, 0, `${continued.err}\n${continued.out}`);
  assert.ok(existsSync(laterRan), 'every other file ran past the waived failure');
  assert.doesNotMatch(`${continued.out}\n${continued.err}`, /stopped early/u);
  assert.match(continued.out, new RegExp(`waived: a flaky landing check \\(${waivedFile.replaceAll('.', '\\.')}\\) by person waiver ${runnerWaiver.id} for file `, 'u'));
  // A waiver by exact test name keeps the run going too, past the file that holds that test.
  const namedFile = 'test/landing-named.test.cjs';
  assert.equal(commitFile(box, box.repo, namedFile, "require('node:test').test('a named landing flake', () => { throw new Error('known flake'); });\n", 'chore: add a named flaky landing test').status, 0);
  setGate(`node ${JSON.stringify(join(dirname(BIN), 'run-tests.js'))} --test-concurrency=1 ${namedFile} test/landing-later.test.cjs`, 'chore: gate the named flake with the real test runner');
  const nameWaiver = json(box, box.repo, 'land', '--waive', 'a named landing flake', '--until', '2099-01-01', '--reason', 'known named flake').waiver;
  rmSync(laterRan);
  const named = box.run(box.repo, 'gate', '--landing');
  assert.equal(named.code, 0, `${named.err}\n${named.out}`);
  assert.ok(existsSync(laterRan), 'every other file ran past the failure waived by name');
  assert.doesNotMatch(`${named.out}\n${named.err}`, /stopped early/u);
  assert.match(named.out, new RegExp(`waived: a named landing flake \\(${namedFile.replaceAll('.', '\\.')}\\) by person waiver ${nameWaiver.id} for name a named landing flake: known named flake`, 'u'));
  setGate(gateCommand, 'chore: restore the single-stage gate');

  onBoard(box, (board) => {
    assert.equal(store.landingWaiverFor(board, { file: FILES[2], name: FILES[0] }), null, 'a file waiver never covers a test merely named like that file');
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'name-waiver', test: 'keeps a named behavior', until: '2099-01-01', reason: 'named fixture' });
    assert.equal(store.landingWaiverFor(board, { file: FILES[3], name: 'keeps a named behavior' })?.kind, 'name');
    assert.equal(store.landingWaiverFor(board, { file: 'keeps a named behavior', name: 'another behavior' }), null, 'a name waiver covers only that name');
    assert.deepEqual(['test/my check.test.js', 'tests/check.rb', 'web/land-1.test.js', 'check.py', 'keeps a named behavior', 'parses a/b in the header'].map(store.landingWaiverKind),
      ['file', 'file', 'file', 'file', 'name', 'name'], 'paths with spaces or other languages stay file waivers');
  });
  assert.equal(commitFile(box, box.repo, FILES[2], `RED NAME:${FILES[0]}\n`, 'chore: install a test named like the waived file').status, 0);
  const spoofed = box.run(box.repo, 'gate', '--landing');
  assert.equal(spoofed.code, 1, 'a failing test named like a waived file path still refuses');
  assert.doesNotMatch(spoofed.out, /waived, not green/u);
  assert.equal(commitFile(box, box.repo, FILES[2], 'PASS\n', 'chore: correct the spoofed fixture test').status, 0);
  assert.equal(commitFile(box, box.repo, FILES[1], 'RED\n', 'chore: install a second failing fixture test').status, 0);
  const refused = box.run(box.repo, 'gate', '--landing');
  assert.equal(refused.code, 1, 'a failure with only an expired waiver refuses the landing gate');
  assert.match(refused.out, /gate red/u);
  assert.doesNotMatch(refused.out, /waived, not green/u);
});

test('land adoption recovers an interrupted gate and keeps one receipt under a new coordinator [B3,R3]', async (t) => {
  const box = landProject();
  const entries = verifiedFour(box);
  writeFileSync(box.hold, 'armed');
  const child = startFixtureChild(process.execPath, [BIN, 'land', '--json'], { cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise((resolveClose) => child.once('close', (status, signal) => resolveClose({ status, signal })));
  t.after(() => {
    writeFileSync(box.release, 'release');
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  });
  await waitFor(() => existsSync(box.entered), 'landing gate entered');
  const card = json(box, box.repo, 'resume');
  const batch = card.landingBatches.at(-1);
  assert.equal(batch.state, 'gating');
  assert.match(batch.logPath, /batch-\d+\.log$/u);
  assert.equal(batch.items.length, 4);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await closed).signal, 'SIGKILL');
  writeFileSync(box.release, 'release');
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_ADOPT');
  box.env.CODEX_THREAD_ID = 'private-adopting-coordinator';
  const adopted = json(box, box.repo, 'land', '--adopt');
  delete box.env.CODEX_THREAD_ID;
  assert.equal(adopted.batch.id, batch.id);
  assert.notEqual(adopted.batch.owner, batch.owner);
  assert.deepEqual(adopted.landed, entries.map((entry) => entry.item));
  assert.equal(events(box).filter((event) => event.event_kind === 'main-moved').length, 1);
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).state, 'landed');
});

test('a hook read waits while land holds the board [C7,B3]', { timeout: 40_000 }, // budget: 40s hang-only ceiling covers both private lock phases and cleanup; the native busy timeout is not a wall-clock maximum.
async (t) => {
  const box = landProject();
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const probe = join(box.dir, 'observe-hook-read.mjs');
  const observedSql = join(box.dir, 'hook-read-attempted');
  writeFileSync(probe, [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const prepare = DatabaseSync.prototype.prepare;',
    "/** Record native-process times without changing the hook result. */",
    "const record = (row) => { try { appendFileSync(process.env.HOOK_READ_ATTEMPT + '.trace', JSON.stringify({ at: Date.now(), pid: process.pid, ...row }) + '\\n'); } catch {} };",
    "record({ phase: 'hook-started', at: Math.round(performance.timeOrigin) });",
    "process.on('exit', () => record({ phase: 'hook-exit', code: process.exitCode ?? 0 }));",
    'const exec = DatabaseSync.prototype.exec;',
    '/** Observe the connection timeout after the production statement executes. */',
    'DatabaseSync.prototype.exec = function (sql, ...args) {',
    '  const value = Reflect.apply(exec, this, [sql, ...args]);',
    "  if (/PRAGMA busy_timeout/u.test(String(sql))) record({ phase: 'busy-timeout', value: Reflect.apply(prepare, this, ['PRAGMA busy_timeout']).get() });",
    '  return value;',
    '};',
    'DatabaseSync.prototype.prepare = function (sql, ...args) {',
    "  if (String(sql) !== 'SELECT * FROM agent WHERE agent_path = ?') return Reflect.apply(prepare, this, [sql, ...args]);",
    "  record({ phase: 'busy-timeout-at-read', value: Reflect.apply(prepare, this, ['PRAGMA busy_timeout']).get() });",
    "  record({ phase: 'prepare-started' }); writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'prepare-started', at: Date.now() }));",
    '  try {',
    '    const statement = Reflect.apply(prepare, this, [sql, ...args]);',
    "    record({ phase: 'prepare-returned' });",
    '    const get = statement.get;',
    '    statement.get = function (...values) {',
    "      record({ phase: 'get-started' }); writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: 'get-started', at: Date.now() }));",
    "      try { const value = Reflect.apply(get, this, values); record({ phase: 'get-returned' }); return value; }",
    '      catch (error) { record({ phase: \'read-error\', message: error.message, errcode: error.errcode }); writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: \'error\', code: error.code ?? null, errcode: error.errcode ?? null, message: error.message })); throw error; }',
    '    };',
    '    return statement;',
    '  } catch (error) { record({ phase: \'read-error\', message: error.message, errcode: error.errcode }); writeFileSync(process.env.HOOK_READ_ATTEMPT, JSON.stringify({ phase: \'error\', code: error.code ?? null, errcode: error.errcode ?? null, message: error.message })); throw error; }',
    '};',
  ].join('\n'));
  /** Emit actual cross-process lock/read times even when the original assertion refuses. */
  const timing = (name, writer, marker) => {
    try {
      t.diagnostic('hook read timings ' + JSON.stringify({
        name, platform: process.platform, node: process.version, observedAt: Date.now(),
        hook: hooks.find((hook) => hook.hookTiming?.marker === marker)?.hookTiming ?? null,
        writerExit: writer.child.writerExit ?? null,
        locked: existsSync(writer.ready) ? JSON.parse(readFileSync(writer.ready, 'utf8')) : null,
        released: existsSync(writer.released) ? JSON.parse(readFileSync(writer.released, 'utf8')) : null,
        read: existsSync(marker + '.trace') ? readFileSync(marker + '.trace', 'utf8').trim().split('\n').map(JSON.parse) : [],
      }));
    } catch (error) {
      t.diagnostic('hook read timings ' + JSON.stringify({ name, captureError: error.message }));
    }
  };
  const writers = [];
  const hooks = [];
  t.after(async () => {
    const settle = async (promise, timeoutMs) => {
      let timer;
      try { return await Promise.race([promise, new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    };
    for (const writer of writers) {
      writeFileSync(writer.release, 'release');
      if (!await settle(writer.closed, 1_000) && writer.child.exitCode === null && writer.child.signalCode === null) {
        try { process.kill(-writer.child.pid, 'SIGTERM'); } catch {}
        if (!await settle(writer.closed, 1_000) && writer.child.exitCode === null && writer.child.signalCode === null) {
          try { process.kill(-writer.child.pid, 'SIGKILL'); } catch {}
          await writer.closed;
        }
      }
    }
    for (const hook of hooks) {
      if (!await settle(hook.closed, 1_000) && hook.exitCode === null && hook.signalCode === null) {
        hook.kill('SIGTERM');
        if (!await settle(hook.closed, 1_000) && hook.exitCode === null && hook.signalCode === null) {
          hook.kill('SIGKILL');
          await hook.closed;
        }
      }
    }
    for (const writer of writers) timing('cleanup-' + writer.name, writer, `${observedSql}-${writer.name}`);
  });
  /** Start both isolated processes and wait for the hook's exact agentAt query attempt. */
  const runHookWhileWriterHolds = async (name) => {
    const writer = startExclusiveWriter(box, boardFile, name);
    writers.push(writer);
    await waitFor(() => existsSync(writer.ready), `${name} exclusive writer`);
    const marker = `${observedSql}-${name}`;
    const hook = launchHookProbe(box, probe, marker);
    hooks.push(hook);
    await waitFor(() => existsSync(marker), `${name} hook agentAt query attempt`);
    return { writer, hook, marker };
  };

  const successful = await runHookWhileWriterHolds('successful-wait');
  // The preload marks the exact agentAt statement preparation; release follows a pending-read observation.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const successObservation = JSON.parse(readFileSync(successful.marker, 'utf8'));
  assert.equal(successful.hook.exitCode, null, `the hook must remain pending at agentAt while SQLite is exclusively locked: ${JSON.stringify(successObservation)} ${successful.hook.stderrText}`);
  assert.ok(['prepare-started', 'get-started'].includes(successObservation.phase), `the hook reached native SQLite prepare or get before release: ${JSON.stringify(successObservation)}`);
  writeFileSync(successful.writer.release, 'release');
  const [writerSuccess, hookSuccess] = await Promise.all([successful.writer.closed, successful.hook.closed]);
  timing('successful-wait', successful.writer, successful.marker);
  assert.equal(writerSuccess.error, null, `the exclusive writer spawned: ${writerSuccess.error?.message ?? ''}`);
  assert.deepEqual({ code: writerSuccess.code, signal: writerSuccess.signal }, { code: 0, signal: null }, successful.writer.child.fixtureFailure ?? 'the exclusive writer commits and closes');
  assert.equal(hookSuccess.error, null, `the hook child spawned: ${hookSuccess.error?.message ?? ''}`);
  assert.deepEqual({ code: hookSuccess.code, signal: hookSuccess.signal }, { code: 0, signal: null }, successful.hook.stderrText);
  assert.ok(existsSync(successful.writer.released), 'the writer releases its exclusive lock only after commit and close');

  const timeout = await runHookWhileWriterHolds('timeout-diagnostic');
  // SQLite's busy timeout accumulates native sleeps; a paused process can exceed it in wall time.
  // The existing test-level hang ceiling bounds this fixture without racing the native refusal.
  let timeoutResult;
  try { timeoutResult = await timeout.hook.closed; }
  finally { timing('timeout-diagnostic', timeout.writer, timeout.marker); }
  assert.equal(timeoutResult.error, null, `the timeout hook child spawned: ${timeoutResult.error?.message ?? ''}`);
  assert.equal(timeoutResult.code, 1, timeout.hook.stderrText);
  assert.match(timeout.hook.stderrText, /BOARD_BUSY/u);
  assert.match(timeout.hook.stderrText, /board file .*board\.sqlite.*another process.*after \d+ms/u);
  assert.match(timeout.hook.stderrText, /after (?:9\d{3}|[1-9]\d{4,})ms/u, 'diagnostics report the actual prolonged lock wait without a wall-clock maximum');
  assert.doesNotMatch(timeout.hook.stderrText, /database is locked/u, 'a timed-out read never emits only SQLite’s bare lock error');
  const timeoutObservation = JSON.parse(readFileSync(timeout.marker, 'utf8'));
  assert.equal(timeoutObservation.phase, 'error', 'the preload observed the actual SQLite refusal');
  assert.ok((timeoutObservation.errcode & 0xff) === 5 || timeoutObservation.code === 'SQLITE_BUSY', `the underlying failure is SQLITE_BUSY/5: ${JSON.stringify(timeoutObservation)}`);
  writeFileSync(timeout.writer.release, 'release');
  const writerTimeout = await timeout.writer.closed;
  timing('timeout-released', timeout.writer, timeout.marker);
  assert.equal(writerTimeout.error, null, `the diagnostic writer spawned: ${writerTimeout.error?.message ?? ''}`);
  assert.deepEqual({ code: writerTimeout.code, signal: writerTimeout.signal }, { code: 0, signal: null }, timeout.writer.child.fixtureFailure ?? 'the diagnostic fixture writer closes cleanly');
  assert.ok(existsSync(timeout.writer.released), 'the diagnostic writer releases after the hook reports its timeout');
});

test('a hook read waits for the lock however slowly it sleeps [C7,B3]', { timeout: 60_000 }, // budget: hang-only ceiling includes the declared 21s delayed-reader input and owned cleanup.
async (t) => {
  const box = landProject();
  const marker = join(box.dir, 'slow-hook-read');
  const attempted = marker + '-attempted';
  const returned = marker + '-returned';
  const probe = join(box.dir, 'delay-hook-read.mjs');
  let writer, hook;
  /** Bound cleanup of the two exact children even when the negative control refuses. */
  const stop = async (child, closed, group = false) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try { group ? process.kill(-child.pid, signal) : child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      let timer;
      try {
        if (await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })])) return;
      } finally { clearTimeout(timer); }
    }
    throw new Error('Owned hook-read child did not close: ' + child.pid);
  };
  t.after(async () => {
    if (writer) writeFileSync(writer.release, 'cleanup');
    try { if (hook) await stop(hook, hook.closed); }
    finally { if (writer) await stop(writer.child, writer.closed, true); }
  });
  writer = startExclusiveWriter(box, join(box.repo, '.git', 'pullboard', 'board.sqlite'), 'slow-reader');
  await waitFor(() => existsSync(writer.ready), 'exclusive writer before the delayed hook');
  writeFileSync(probe, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const prepare = DatabaseSync.prototype.prepare; let delayed = false;',
    '/** Delay the real reader beyond the old writer expiry without slowing unrelated processes. */',
    'DatabaseSync.prototype.prepare = function(sql, ...args) {',
    "  if (delayed || String(sql) !== 'SELECT * FROM agent WHERE agent_path = ?') return Reflect.apply(prepare, this, [sql, ...args]);",
    '  delayed = true;',
    "  writeFileSync(process.env.HOOK_READ_ATTEMPT, 'reader paused');",
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 21_000);', // budget: declared 21s reader delay crosses the former 20s writer expiry; this is the negative-control input, not a speed assertion.
    "  writeFileSync(process.env.HOOK_READ_ATTEMPT + '-attempted', 'reader resumed');",
    '  const statement = Reflect.apply(prepare, this, [sql, ...args]);',
    "  writeFileSync(process.env.HOOK_READ_ATTEMPT + '-returned', JSON.stringify({ released: existsSync(" + JSON.stringify(writer.release) + ") }));",
    '  return statement;',
    '};',
  ].join('\n'));
  hook = launchHookProbe(box, probe, marker);
  await waitFor(() => existsSync(marker), 'reader entered its controlled pause');
  await waitFor(() => existsSync(attempted), 'reader resumed after the old writer expiry', 30_000); // budget: event ceiling covers the declared 21s reader pause.
  assert.equal(writer.child.exitCode, null, 'the writer still holds its lock after the delayed reader resumes');
  assert.equal(writer.child.signalCode, null);
  assert.equal(existsSync(writer.released), false, 'no release was requested or performed');
  assert.equal(hook.exitCode, null, 'the real hook is still waiting for the held board');
  assert.equal(existsSync(returned), false, 'the native agentAt prepare has not returned through the lock');
  writeFileSync(writer.release, 'release');
  const [writerResult, hookResult] = await Promise.all([writer.closed, hook.closed]);
  assert.deepEqual(writerResult, { code: 0, signal: null, error: null }, writer.child.fixtureFailure);
  assert.deepEqual(hookResult, { code: 0, signal: null, error: null }, hook.stderrText);
  assert.deepEqual(JSON.parse(readFileSync(returned, 'utf8')), { released: true }, 'the hook completed only after the test released the writer');
  assert.ok(existsSync(writer.released), 'the writer committed and closed its lock');
});

test('landing diagnostics retain unknown failures and merge subjects obey typed 72-character headers [B3,R3]', () => {
  const root = '/private/landing';
  const failures = landingFailures(`not ok 1 - located failure\n  location: ${root}/test/one.test.js:3:4\nnot ok 2 - unknown failure\n`, root);
  assert.deepEqual(failures, [{ name: 'located failure', file: 'test/one.test.js' }, { name: 'unknown failure', file: null }]);
  // Node 24 node --test reports with spec by default: its failing-tests summary names each file and test (#1071).
  const spec = landingFailures(`\u2716 red one (1.2ms)\n\u2716 failing tests:\n\ntest at web/red.test.js:6:1\n\u2716 red one (1.2ms)\n  AssertionError\n\ntest at /elsewhere/x.test.js:1:1\n\u2716 outside (3ms)\n`, root);
  assert.deepEqual(spec, [{ name: 'red one', file: 'web/red.test.js' }, { name: 'outside', file: null }], 'spec failures keep their file, and an outside path is unknown');
  const subject = landingSubject({ item_id: 91, item_title: 'A VERY LONG TITLE '.repeat(10), item_spec_ids: 'B3,R3' });
  assert.equal(subject, 'chore(merge): a very long title a very long title a very long [B3,R3]');
  assert.ok(subject.length <= 72);
});

test('land bisect adoption retains completed gates, isolated diagnostics and original candidates [B3,R3]', async (t) => {
  const box = landProject();
  const entries = verifiedFour(box, { red: 2 });
  writeFileSync(box.trace, '');
  writeFileSync(box.hold, '3');
  const child = startFixtureChild(process.execPath, [BIN, 'land', '--json'], { cwd: box.repo, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputBytes = 0;
  child.stdout.on('data', part => { outputBytes += Buffer.byteLength(part); });
  child.stderr.on('data', part => { outputBytes += Buffer.byteLength(part); });
  const closed = new Promise((resolveClose) => child.once('close', (status, signal) => resolveClose({ status, signal })));
  t.after(() => {
    writeFileSync(box.release, 'release');
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  });
  await waitForFixtureProgress({
    child,
    ready: () => existsSync(box.entered),
    progress: () => outputBytes + [box.calls, box.trace].reduce((bytes, file) =>
      bytes + (existsSync(file) ? readFileSync(file).length : 0), 0),
    description: 'third full gate inside bisection',
  });
  const interrupted = json(box, box.repo, 'resume').landingBatches.at(-1);
  assert.equal(interrupted.items.length, 2, 'the current half differs from the original four candidates');
  assert.equal(interrupted.gateResults.length, 2);
  assert.deepEqual(interrupted.diagnostics, [{ test: FILES[2], isGreen: false }]);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await closed).signal, 'SIGKILL');
  writeFileSync(box.release, 'release');
  const result = json(box, box.repo, 'land', '--adopt');
  assert.deepEqual(result.landed, [entries[0].item, entries[1].item, entries[3].item]);
  const trace = readFileSync(box.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(trace.filter((row) => !row.alone && row.files.length === 4).length, 1, 'completed initial red is not retried');
  assert.equal(trace.filter((row) => !row.alone && row.files.join(',') === FILES.slice(0, 2).join(',')).length, 1, 'completed green half is not retried');
  assert.equal(trace.filter((row) => row.alone && row.files[0] === FILES[2]).length, 1, 'the isolated red is not retried');
  assert.equal(json(box, box.repo, 'show', String(entries[2].item)).thread.filter((entry) => entry.type === 'fact').length, 1);
});

test('landing records replay identically with native sender and engine boundaries [B3,R3,H16]', (t) => {
  const box = landProject();
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  const document = onBoard(box, (board) => exportBoard(board));
  const boards = ['one', 'two'].map((name, index) => {
    const board = store.openBoard(join(box.dir, `${name}.sqlite`), { now: () => new Date(index ? '2030-01-01' : '2020-01-01') });
    importBoard(board, document);
    return board;
  });
  t.after(() => boards.forEach((board) => store.closeBoard(board)));
  const batch = { version: 1, id: 'replayed-batch', state: 'pushed', base: box.git(box.repo, 'rev-parse', 'HEAD'), tip: entry.commit,
    root: join(box.repo, '.git', 'pullboard', 'landings', 'replayed-batch', 'worktree'), branch: 'refs/heads/main', owner: 'coordinator-fixture',
    logPath: join(box.dir, 'replayed-gate.log'), items: [{ id: entry.item, commit: entry.commit, merge: entry.commit }] };
  const operations = [
    ['recordLandingBatch', [{ agentId: 'coordinator', batch }], 'coordinator'],
    ['recordLandingWaiver', [{ agentId: 'person', channel: 'terminal', id: 'replayed-waiver', test: FILES[0], until: '2099-01-01', reason: 'private replay exception' }], 'person'],
    ['recordLandingFlake', [{ agentId: 'coordinator', test: FILES[0], hash: 'd'.repeat(64), names: ['private failing test'], lane: 'web', batchId: batch.id }], 'coordinator'],
    ['finishLandingBatch', [{ agentId: 'coordinator', id: batch.id, tip: entry.commit }], 'coordinator'],
  ];
  for (const [index, [operation, args, actor]] of operations.entries()) {
    const move = prepareEngineMove(boards[0], operation, args, { id: `landing-replay-${index}`, actor });
    const options = { sequence: index + 1, at: '2026-10-10T17:30:00.000Z', kind: 'move',
      sender: actor === 'person' ? { kind: 'person', userId: 'fixture-person' } : { kind: 'agent', agent: actor, userId: 'fixture-person' } };
    const one = applyRelayMove(boards[0], move, options);
    const two = applyRelayMove(boards[1], move, options);
    assert.equal(one.error, undefined, JSON.stringify(one));
    assert.deepEqual(one, two);
    const before = store.events(boards[0]);
    assert.deepEqual(applyRelayMove(boards[0], move, options), one, 'replay of a receipt is idempotent');
    assert.deepEqual(store.events(boards[0]), before);
  }
  assert.deepEqual(store.events(boards[0]), store.events(boards[1]), 'different local clocks produce the same authoritative events');
  assert.equal(store.getItem(boards[0], entry.item).item_merged_commit, entry.commit);
  assert.equal(store.events(boards[0]).filter((event) => event.event_kind === 'main-moved').length, 1);
  const old = prepareEngineMove(boards[0], 'recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, id: 'old-engine-batch' } }], { id: 'old-engine-landing', actor: 'coordinator' });
  assert.throws(() => applyRelayMove(boards[0], { ...old, engine: 7 }, { sequence: 5, at: '2026-10-10T17:31:00.000Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture-person', agent: 'coordinator' } }), { code: 'RELAY_MOVE' });
  const forged = prepareEngineMove(boards[0], 'recordLandingWaiver', operations[1][1], { id: 'forged-landing-waiver', actor: 'person' });
  const spoof = applyRelayMove(boards[0], forged, { sequence: 5, at: '2026-10-10T17:32:00.000Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture-person', agent: 'web-1' } });
  assert.equal(spoof.error?.code, 'RELAY_PERSON_ONLY');
});

test('an item with no spec rows lands under a header its commit hook accepts [B3,R3]', () => {
  const box = landProject();
  // A docs-lane item with no spec rows: its commit cites none, and its merge header names its lane's type.
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.docs = { owns: ['docs/'], specs: [] };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add a docs lane');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const path = join(box.dir, 'docs-land-1');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'docs/land-1', path, 'main');
  assert.equal(box.run(path, 'join', 'docs').code, 0);
  const added = box.run(box.repo, 'add', 'docs', 'Docs fixture with no rows', '--criterion', 'the docs fixture is valid',
    '--check', `node ${JSON.stringify(box.checks)} ${JSON.stringify('docs/land-1.test.js')}`, '--json');
  assert.equal(added.code, 0, added.err);
  const item = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(path, 'claim', String(item)).code, 0);
  mkdirSync(join(path, 'docs'), { recursive: true });
  writeFileSync(join(path, 'docs', 'land-1.md'), 'docs\n');
  writeFileSync(join(path, 'docs', 'land-1.test.js'), 'PASS\n');
  box.git(path, 'add', '-A');
  box.git(path, 'commit', '-q', '-m', 'docs(docs): describe the docs fixture');
  const entry = { path, item, file: 'docs/land-1.test.js', commit: box.git(path, 'rev-parse', 'HEAD') };
  assert.equal(box.run(path, 'submit', String(item)).code, 0, 'the docs commit submits');
  acceptItem(box, entry);
  const base = box.git(box.repo, 'rev-parse', 'main');
  const result = json(box, box.repo, 'land', '--max', '1');
  assert.deepEqual(result.landed, [item]);
  const [subject] = mergeSubjects(box, base, result.batch.tip);
  assert.equal(subject, 'docs(merge): docs fixture with no rows', 'a docs-lane item with no rows lands under docs(merge)');
});

test('publish pushes only a head the whole suite passed and names every red [B3,R3]', () => {
  const box = landProject();
  const entries = verifiedFour(box, { red: 1 });
  const before = box.git(box.remote, 'rev-parse', 'main');
  // Tier 1 by hand: each verified item lands on the local trunk only, as pullboard merged records it.
  for (const entry of entries) {
    box.git(box.repo, 'merge', '-q', '--no-ff', '-m', `chore(merge): land fixture ${entry.item} [G1]`, entry.commit);
    const merged = box.run(box.repo, 'merged', String(entry.item), box.git(box.repo, 'rev-parse', 'HEAD'));
    assert.equal(merged.code, 0, merged.err);
  }
  const head = box.git(box.repo, 'rev-parse', 'main');
  const start = calls(box).length;
  const red = box.run(box.repo, 'publish', '--json');
  assert.equal(red.code, 1, 'a red head fails publish');
  const report = JSON.parse(red.out);
  assert.equal(report.published, false);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), before, 'a red head is never pushed');
  assert.deepEqual(report.red.map((entry) => entry.file), [FILES[1]], 'every failing test is named from the one run');
  assert.deepEqual(report.red[0].items, [entries[1].item], 'the failing file names the landed item whose merge touched it');
  assert.equal(calls(box).length - start, 1, 'one whole-suite run');
  const again = box.run(box.repo, 'publish', '--json');
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.out).waiting, true, 'the same red head waits for a new head');
  assert.equal(calls(box).length - start, 1, 'waiting runs no tests');
  // A fix lands on the trunk; the new head passes the whole suite and is pushed exactly.
  assert.equal(commitFile(box, box.repo, FILES[1], 'PASS\n', 'fix(web): land fixture 2 passes again [G1]').status, 0);
  const fixed = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(fixed, head);
  const green = json(box, box.repo, 'publish');
  assert.equal(green.published, true);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), fixed, 'only the head the whole suite passed reaches the remote');
});

test('an accepted item lands on the local trunk before the whole suite runs [B3,R3]', () => {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land on the local trunk first');
  const entries = verifiedFour(box);
  const remoteBefore = box.git(box.remote, 'rev-parse', 'main');
  const start = calls(box).length;
  const result = json(box, box.repo, 'land', '--max', '4');
  assert.deepEqual(result.landed.sort((a, b) => a - b), entries.map((entry) => entry.item).sort((a, b) => a - b));
  assert.equal(result.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip, 'the local trunk holds the landed batch');
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), remoteBefore, 'tier 1 pushes nothing');
  assert.deepEqual(calls(box).slice(start), [], 'no whole-suite run before the items land');
  const merges = box.git(box.repo, 'rev-list', '--first-parent', `${result.batch.base}..${result.batch.tip}`).split('\n');
  for (const entry of entries) assert.ok(merges.includes(json(box, box.repo, 'show', String(entry.item)).item_merged_commit), `#${entry.item} has its merged receipt on the local trunk`);
  // Tier 2 then runs the whole suite once on that exact head and pushes it.
  const published = json(box, box.repo, 'publish');
  assert.equal(published.published, true);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
  assert.equal(calls(box).length - start, 1, 'publish ran the whole suite once');
});

test('a publish gate run is recorded and a red and green pair it sees files the flake [C7,D1]', () => {
  const box = landProject();
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, flakes: { rerun: false } }, null, 2));
  assert.equal(commitFile(box, box.repo, FILES[0], 'RED\n', 'test: commit the publish target [G1]').status, 0);
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const firstHead = box.git(box.repo, 'rev-parse', 'HEAD');
  const remoteBefore = box.git(box.remote, 'rev-parse', 'main');
  const before = calls(box).length;
  const red = box.run(box.repo, 'publish', '--json');
  assert.equal(red.code, 1, red.err);
  /** Read only the receipts actual gate executions wrote. */
  const runs = () => onBoard(box, board => store.gateRuns(board));
  /** Count repair items independently of unrelated diagnostic observations. */
  const flakes = () => onBoard(box, board => store.listItems(board, { all: true }).filter(item => item.item_title.startsWith('Flaky test:')));
  const [failed] = runs();
  assert.ok(failed, 'the red publish records its authentic gate receipt');
  assert.equal(failed.tree, tree);
  assert.equal(failed.green, false);
  assert.equal(failed.by, 'coordinator');
  assert.equal(failed.failures[0].file, FILES[0]);
  assert.equal(flakes().length, 0, 'one red run alone does not prove a flake');
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), remoteBefore, 'the red head stays local');
  assert.equal(json(box, box.repo, 'publish').waiting, true, 'the same red HEAD still waits');
  assert.equal(runs().length, 1, 'waiting records no fabricated execution');
  assert.equal(calls(box).length - before, 1);

  // New commit, unchanged tree: publish may try again without bypassing its same-HEAD retry guard.
  box.env.LAND_SUPPRESS_RED = '1';
  box.git(box.repo, 'commit', '--allow-empty', '-q', '-m', 'test: observe the same tree again [G1]');
  const greenHead = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.notEqual(greenHead, firstHead);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD^{tree}'), tree);
  assert.equal(json(box, box.repo, 'publish').published, true);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), greenHead);
  assert.deepEqual(runs().map(run => [run.tree, run.green]), [[tree, false], [tree, true]]);
  const [repair] = flakes();
  assert.equal(flakes().length, 1, 'publish alone proves the same-tree flake and files it once');
  assert.ok(repair.item_brief.includes(failed.id) && repair.item_brief.includes(runs()[1].id), 'the item cites both actual publish receipts');
  assert.equal(onBoard(box, board => store.flakeQuarantines(board)).length, 1);

  box.git(box.repo, 'commit', '--allow-empty', '-q', '-m', 'test: observe a third publish [G1]');
  assert.equal(json(box, box.repo, 'publish').published, true);
  assert.deepEqual(runs().map(run => [run.tree, run.green]), [[tree, false], [tree, true], [tree, true]]);
  assert.equal(flakes().length, 1, 'another publish receipt creates no duplicate flake item');
  assert.equal(calls(box).length - before, 3, 'each receipt represents one actual full publish gate');
});
test('a landing gate past its timeout stops cleanly [E27,E29]', () => landingTimeoutFixture({ landProject, itemWorktree, submitItem, acceptItem, onBoard, json }));

test('landing tests candidate batches in parallel and lands the longest green prefix [B3,V4]', { timeout: 180_000 }, // budget: two real three-item private landings and bounded overlap barriers; no speed threshold.
() => assertParallelLanding({ landProject, itemWorktree, submitItem, acceptItem, json }));

test('parallel CLI landing retains its lease and fences lost authority [B3,V4,Q1,Q3]', { timeout: 180_000 }, // budget: two private CLI landings with cooperative gate barriers; hang ceiling only, no speed threshold.
async () => assertParallelCliLease({ landProject, itemWorktree, submitItem, acceptItem, onBoard, waitFor, BIN }));

test('parallel landing refuses a live inherited gate before scheduling [B3,V4,Q1,Q3]', { timeout: 90_000 }, // budget: private verified item plus two immediate guarded entries; hang ceiling only.
() => assertParallelNestedGate({ landProject, itemWorktree, submitItem, acceptItem, onBoard, BIN }));
test('the landing merge assigns engine numbers in landing order, either order, and the board replays [B3,R3,H16]', () => {
  for (const order of [[0, 1], [1, 0]]) landEnginesInOrder({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }, order);
});

test('a landing batch leaves out an item that touches a file already in the batch [B3,R3,R1,H16]',
() => assertCollisionFreeLanding({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }));

test('a deferred landing item keeps its place ahead of newer acceptances after merge-only reaccept [B3,R3,R1,H16]',
() => assertDeferredLandingPriority({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }));
