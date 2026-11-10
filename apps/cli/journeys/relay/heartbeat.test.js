// @pullboard-test-loads packages/link/src/io/relay.js apps/cli/src/io/entry.js src/relay-sender-worker.js apps/cli/src/io/sender.js
/** A slow real multi-board pass must not make a live sender look abandoned [H21,H5,H16]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SENDER_CLAIM_STALE_MS } from '../../../../packages/link/index.js';
import { SENDER_WORKER } from '../../index.js';
import { outboxFile } from '../../../../packages/outbox/index.js';
import {
  runFixtureChildAsync,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

const CLI = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
const LOCAL_FIRST = new URL('../../../../packages/link/index.js', import.meta.url).href;
const RELAY = new URL('../../../../packages/link/index.js', import.meta.url).href;
const POLICY = new URL('../../index.js', import.meta.url).href;
const OPENERS = new URL('../../tests/fixtures/board.js', import.meta.url).href;
// Budget: each real reply waits below the unchanged production ten-second per-request deadline.
const RESPONSE_HOLD_MS = 5000;
const MOVES = 26; // Twenty-six genuine queued moves keep one flush awaiting I/O beyond the real two-minute claim window.

/** Wait for an actual lifecycle barrier, with a finite failure ceiling rather than a latency assertion. */
async function until(description, ready, ceilingMs = 10_000) {
  const deadline = performance.now() + ceilingMs;
  while (performance.now() < deadline) {
    if (ready()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(description);
}

/** Preserve the committed absent-setting default before linking either genuine private fixture board. */
function commitDefault(root, env) {
  const file = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (config.relay) delete config.relay.outbox;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: root, env });
  // --allow-empty: a project whose committed config already has no relay.outbox changes nothing, and that is the default being kept.
  runFixtureGit(['commit', '-q', '--allow-empty', '-m', 'chore(config): keep the production sender default'], { cwd: root, env });
}

/** Run the real CLI during unlinked setup without enabling the sender before both boards are ready. */
async function cli(root, env, args) {
  const result = await runFixtureChildAsync(process.execPath, [CLI, ...args, '--json'], { cwd: root, env });
  assert.equal(result.status, 0, result.context);
  return JSON.parse(result.stdout);
}

/** Initialize a second genuine repository against the same account and relay, sharing exactly one machine home. */
async function secondBoard(box) {
  const root = join(box.root, '..', 'second-board');
  mkdirSync(root);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env: box.env });
  writeFileSync(join(root, 'README.md'), 'private second sender fixture\n');
  runFixtureGit(['add', 'README.md'], { cwd: root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'fixture base'], { cwd: root, env: box.env });
  await cli(root, box.env, ['init']);
  commitDefault(root, box.env);
  const repository = 'sender-second-repository';
  box.providerState.repositories.push(repository);
  runFixtureGit(['remote', 'add', 'origin', `git@github.com:fixture/${repository}.git`], { cwd: root, env: box.env });
  await cli(root, box.env, ['relay', 'on', '--url', box.origin]);
  const file = join(root, '.git/pullboard/relay.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(state.baselineAccepted, true);
  return { root, file, id: state.board, env: box.env };
}

/** Capture only a freshly spawned fixture worker's start, command and cwd; never enumerate another process. */
function workerIdentity(pid, root) {
  let metadata;
  try { metadata = execFileSync('ps', ['-p', String(pid), '-o', 'stat=,lstart=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
  if (/^Z/u.test(metadata)) return null; // A zombie has exited; it must not be signalled or mistaken for a reused live worker.
  assert.ok(metadata.includes(SENDER_WORKER), 'the recorded fixture PID still runs the expected sender entry');
  let cwd;
  try {
    cwd = process.platform === 'linux' ? readlinkSync(`/proc/${pid}/cwd`)
      : execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').find(line => line.startsWith('n'))?.slice(1);
  } catch (error) {
    let state;
    try { state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
    if (state.startsWith('Z')) return null;
    throw error;
  }
  assert.equal(cwd, root, 'only this freshly spawned private worker belongs to the test');
  const command = metadata.replace(/^\S+\s+/u, '');
  const started = command.match(/^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})/u)?.[1].replace(/\s+/gu, ' ');
  assert.ok(started, 'the owned worker has a parseable original start identity');
  return { pid, metadata: command, started, cwd };
}

/** After a verified signal, observe only identity and state: an exiting process need not retain its live command or cwd. */
function exitObservation(record) {
  let row;
  try { row = execFileSync('ps', ['-p', String(record.pid), '-o', 'lstart=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (error) {
    try { process.kill(record.pid, 0); }
    catch (gone) { if (gone.code === 'ESRCH') return { pid: record.pid, terminal: true, reason: 'ESRCH' }; }
    throw error;
  }
  const match = /^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)$/u.exec(row);
  assert.ok(match, 'the post-signal start/state observation is parseable');
  const started = match[1].replace(/\s+/gu, ' '), state = match[2];
  const reason = started !== record.started ? 'original start gone' : state.startsWith('Z') ? 'zombie' : 'still running';
  return { pid: record.pid, started, state, reason, terminal: reason !== 'still running' };
}

/** Recheck exact PID/start/cwd immediately before terminating only this test's recorded sender. */
async function stopWorker(record) {
  const current = workerIdentity(record.pid, record.cwd);
  if (!current) return { pid: record.pid, terminal: true, reason: 'not running before signal' };
  assert.ok(current.metadata === record.metadata, 'a reused PID is never signalled');
  const checked = workerIdentity(record.pid, record.cwd);
  assert.ok(checked?.metadata === record.metadata, 'the exact identity is unchanged immediately before signalling');
  process.kill(record.pid, 'SIGTERM');
  let observed;
  await until('the exact fixture sender did not terminate', () => { observed = exitObservation(record); return observed.terminal; });
  return observed;
}

/** Nudge once through the public helper, passively recording only the exact real child handles it creates. */
async function nudge(root, file, env, workers) {
  const source = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const original = childProcess.spawn, spawned = [];
    childProcess.spawn = function (...args) {
      const child = original.apply(this, args);
      if (args[0] === process.execPath && args[1]?.[0] === ${JSON.stringify(SENDER_WORKER)}) spawned.push(child.pid);
      return child;
    };
    syncBuiltinESMExports();
    const { nudgeRelaySender } = await import(${JSON.stringify(LOCAL_FIRST)});
    const { launchRelaySender } = await import(${JSON.stringify(new URL('../../index.js', import.meta.url).href)});
    nudgeRelaySender(process.cwd(), ${JSON.stringify(file)}, launchRelaySender);
    process.stdout.write(JSON.stringify({ spawned, home: process.env.PULLBOARD_HOME }));
  `;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env });
  assert.equal(result.status, 0, result.context);
  const output = JSON.parse(result.stdout);
  assert.equal(output.home, env.PULLBOARD_HOME);
  for (const pid of output.spawned) {
    const record = workerIdentity(pid, root);
    assert.ok(record, 'the real spawned worker is alive for exact cleanup registration');
    workers.push(record);
  }
  return output.spawned;
}

/** Queue genuine ordinary native moves with saved credentials, before any background sender is started. */
async function queueMoves(box) {
  const source = `
    const { relayOperation } = await import(${JSON.stringify(RELAY)});
    const { cli$relayOutboxSetting: relayOutboxSetting } = await import(${JSON.stringify(POLICY)});
    const { apiBoardOpeners } = await import(${JSON.stringify(OPENERS)});
    const io = { ...apiBoardOpeners, err() {}, relayOutbox: () => relayOutboxSetting(process.cwd()) };
    for (let index = 0; index < ${MOVES}; index++) await relayOperation(process.cwd(), 'shout',
      [{ from: 'coordinator', to: 'all', lanes: [], text: 'Slow real sender move ' + index }], io);
    process.stdout.write(JSON.stringify({ queued: ${MOVES} }));
  `;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: box.root, env: box.env });
  assert.equal(result.status, 0, result.context);
  assert.equal(JSON.parse(result.stdout).queued, MOVES);
  assert.equal(existsSync(outboxFile(box.linkFile)), true);
}

test('one sender keeps its claim through a slow multi-board pass [H21,H5,H16]', { timeout: 660_000 }, async t => { // budget: one real two-minute stale window, under-deadline replies, and bounded fixture cleanup.
  t.diagnostic(JSON.stringify({ node: process.version, host: hostname(), execPath: process.execPath,
    binarySha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') }));
  const workers = [], pending = new Set(), cleanupErrors = [];
  let slowing = true;
  /** Release all real response barriers before any owned worker or fixture is cleaned up. */
  const releaseAll = () => { slowing = false; for (const release of [...pending]) release(); };
  t.after(async () => {
    releaseAll();
    const stopped = await Promise.allSettled(workers.map(stopWorker));
    for (const [index, result] of stopped.entries()) {
      if (result.status === 'fulfilled') t.diagnostic(JSON.stringify({ cleanupExit: result.value }));
      else {
        cleanupErrors.push(result.reason);
        t.diagnostic(JSON.stringify({ cleanupError: { pid: workers[index].pid, name: result.reason.name,
          code: result.reason.code ?? null, message: result.reason.message } }));
      }
    }
  });
  const box = await relayClientFixture(t);
  // Report every scoped cleanup failure only after the fixture's normal provider and relay closers have run.
  t.after(() => { if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'scoped fixture sender cleanup failed'); });
  commitDefault(box.root, box.env);
  await box.link();
  const other = await secondBoard(box);
  assert.notEqual(JSON.parse(readFileSync(box.linkFile, 'utf8')).board, other.id);
  assert.equal(other.env.PULLBOARD_HOME, box.env.PULLBOARD_HOME);
  assert.equal(other.env.PULLBOARD_MACHINE_HOME, box.env.PULLBOARD_MACHINE_HOME);
  await queueMoves(box);
  let firstResponse;
  const reached = new Promise(resolve => { firstResponse = resolve; });
  let responseIndex = 0, firstAt = 0;
  /** Hold each genuine move response below its unchanged ten-second transport deadline. */
  async function slowResponse() {
    if (!slowing) return;
    box.beforeNextMove(slowResponse);
    responseIndex++;
    if (!firstAt) { firstAt = performance.now(); firstResponse(); }
    await new Promise(resolve => {
      let timer;
      const release = () => { clearTimeout(timer); pending.delete(release); resolve(); };
      pending.add(release);
      timer = setTimeout(release, RESPONSE_HOLD_MS);
    });
  }
  box.beforeNextMove(slowResponse);
  const env = { ...box.env };
  delete env.PULLBOARD_RELAY_SENDER_BACKGROUND;
  assert.equal(env.PULLBOARD_RELAY_TOKEN, undefined);
  const claim = join(env.PULLBOARD_HOME, 'relay-sender/sender.pid');
  try {
    assert.equal((await nudge(box.root, box.linkFile, env, workers)).length, 1);
    await until('the sender never reached its first real relay response', () => firstAt > 0, 20_000);
    await reached;
    await until('the first sender did not claim its machine home', () => existsSync(claim));
    const first = workers[0];
    assert.equal(Number(readFileSync(claim, 'utf8')), first.pid);
    const wait = firstAt + SENDER_CLAIM_STALE_MS + 500 - performance.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait)); // Real elapsed time is the tested stale window, never a fake timestamp.
    assert.ok(performance.now() - firstAt > SENDER_CLAIM_STALE_MS);
    assert.ok(pending.size > 0 && responseIndex <= MOVES, 'the first worker is still awaiting a held real relay response in this same flush');
    assert.equal(existsSync(outboxFile(box.linkFile)), true, 'the same genuine first-board flush still has queued work');
    assert.doesNotMatch(readFileSync(join(env.PULLBOARD_HOME, 'relay-sender/sender.log'), 'utf8'), /served in/u,
      'the original serve has not completed or timed out and restarted');
    assert.ok(workerIdentity(first.pid, first.cwd)?.metadata === first.metadata, 'the original worker is alive with its original start and cwd');
    const claimAgeMs = Date.now() - statSync(claim).mtimeMs;
    const secondReads = () => box.calls.filter(call => call.method === 'GET' && call.path.includes('/boards/' + other.id + '/')).length;
    const readsBefore = secondReads();
    const created = await nudge(other.root, other.file, env, workers);
    if (created.length) await until('the replacement worker did not expose its claim', () => Number(readFileSync(claim, 'utf8')) === created[0]);
    assert.ok(workerIdentity(first.pid, first.cwd)?.metadata === first.metadata, 'a replacement cannot be justified by the first worker exiting');
    t.diagnostic(JSON.stringify({ realHeldMs: performance.now() - firstAt, claimAgeMs, responseIndex,
      workers: workers.map(({ pid, metadata, cwd }) => ({ pid, startAndCommand: metadata, cwd })) }));
    assert.equal(created.length, 0, 'a slow pass cannot spawn another live sender for the same machine home');
    assert.equal(Number(readFileSync(claim, 'utf8')), first.pid, 'the original sender retains the claim');
    releaseAll();
    await until('the first board outbox did not drain after releasing real responses', () => !existsSync(outboxFile(box.linkFile)), 30_000);
    await until('the same sender did not serve the second board', () => secondReads() > readsBefore, 30_000);
    assert.ok(workerIdentity(first.pid, first.cwd)?.metadata === first.metadata, 'one original sender finishes both boards');
  } finally { releaseAll(); }
});

test('a real local-first CLI read starts its owned background sender [H21,C7]', async t => {
  let box, record;
  t.after(async () => {
    if (!record && box) {
      const claim = join(box.env.PULLBOARD_HOME, 'relay-sender/sender.pid');
      if (existsSync(claim)) record = workerIdentity(Number(readFileSync(claim, 'utf8')), box.root);
    }
    if (record) await stopWorker(record);
  });
  box = await relayClientFixture(t);
  commitDefault(box.root, box.env);
  await box.link();
  const env = { ...box.env };
  delete env.PULLBOARD_RELAY_SENDER_BACKGROUND;
  assert.equal(env.PULLBOARD_RELAY_TOKEN, undefined);
  const claim = join(env.PULLBOARD_HOME, 'relay-sender/sender.pid');
  assert.equal(existsSync(claim), false, 'setup did not start a sender');
  await cli(box.root, env, ['list']);
  await until('the local-first CLI read did not start its sender', () => existsSync(claim));
  record = workerIdentity(Number(readFileSync(claim, 'utf8')), box.root);
  assert.ok(record, 'the real read launched the actual CLI-owned sender entry in this private checkout');
});
