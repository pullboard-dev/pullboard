/** Exercise landing against real private Git worktrees, hooks, SQLite and bare remotes [B3,R3]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { startFixtureChild } from '../../tests/fixtures/child.js';
import { stopGroup } from '../../tests/fixtures/runner/group.js';
import {
  MARKER_NOT_YET,
  readMarker,
} from '../../tests/fixtures/land/marker.js';
import {
  childOutcome,
  startExclusiveBoardWriter,
  useRollbackJournal,
} from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, waitFor, BIN } = e2e;
const { landProject } = makeLandProjectFixtures({ sandbox, project, commitFile });


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
      await stopGroup(writer.child, writer.closed);
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

  useRollbackJournal(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
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
      await stopGroup(writer.child, writer.closed);
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
      await stopGroup(writer.child, writer.closed);
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
    finally { if (writer) await stopGroup(writer.child, writer.closed); }
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
