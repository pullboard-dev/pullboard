/** Native lock admission and submit preparation keep slow repository work outside SQLite [C7]. */
/** @pullboard-test-input apps/lib/index.js packages/resources/index.js packages/store/index.js */
/** @pullboard-test-loads packages/store/index.js packages/resources/index.js */
import {
  openBoard,
  closeBoard,
} from '../../../../../lib/index.js';
import * as store from '../../../../../../packages/store/index.js';
import { submitPreflight } from '../../../../../../packages/items/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureChild } from '../../../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../../tests/fixtures/testkit.js';

/** Give in-process metrics the same private machine custody as the fixture's SQLite file. */
function privateHome(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-busy-retry-'));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Release only this test's raw SQLite holder after a contender proves it encountered real contention. */
async function proveRetry(t, directory, kind) {
  const file = join(directory, kind === 'resource' ? 'resources.sqlite' : 'board.sqlite');
  if (kind === 'resource') {
    const { listResources } = await import('../../../../../../packages/resources/index.js');
    listResources();
  }
  const holder = new DatabaseSync(file);
  holder.exec('CREATE TABLE IF NOT EXISTS retry_proof (value INTEGER); BEGIN IMMEDIATE');
  t.after(() => holder.close());
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    const [file, kind, storeUrl, resourcesUrl, appUrl] = process.argv.slice(1);
    await import(appUrl);
    const store = await import(storeUrl);
    const resources = await import(resourcesUrl);
    const original = DatabaseSync.prototype.exec;
    let busy = false;
    DatabaseSync.prototype.exec = function(sql) {
      try { return original.call(this, sql); }
      catch (error) {
        if (sql === 'BEGIN IMMEDIATE' && /locked/u.test(error.message) && !busy) {
          busy = true;
          process.send({ kind: 'busy' });
        }
        throw error;
      }
    };
    if (kind === 'resource') resources.listResources();
    else {
      const db = new DatabaseSync(file);
      db.exec('PRAGMA busy_timeout=1');
      store.beginImmediateQueued(db, Date.now());
      db.exec('INSERT INTO retry_proof VALUES (1); COMMIT');
      db.close();
    }
    if (!busy) throw new Error('the fixture did not encounter a real locked database');
    process.disconnect();
  `;
  // Process-level: a separate node process contends for the real SQLite lock over IPC.
  const child = startFixtureChild(process.execPath, ['--input-type=module', '-e', source, file, kind,
    new URL('../../../../../../packages/store/index.js', import.meta.url).href,
    new URL('../../../../../../packages/resources/index.js', import.meta.url).href,
    new URL('../../../../../lib/index.js', import.meta.url).href], {
    env: { ...process.env, PULLBOARD_MACHINE_HOME: directory }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let released = false;
  child.on('message', message => {
    if (message?.kind === 'busy' && !released) { holder.exec('COMMIT'); released = true; }
  });
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  assert.equal(code, 0, child.fixtureFailure);
  assert.equal(released, true, 'the native retry outlived real lock contention');
  if (kind === 'board') assert.equal(holder.prepare('SELECT count(*) AS n FROM retry_proof').get().n, 1);
}

test('board and dispatcher startup writers retry real contention without raw SQLite errors [C7]', { timeout: 20_000 }, async t => {
  const directory = privateHome(t);
  await proveRetry(t, directory, 'board');
  await proveRetry(t, directory, 'resource');
});

test('default admission stops at its ten-second budget with BOARD_BUSY and restores the caller timeout [C7]', t => {
  const directory = privateHome(t);
  const file = join(directory, 'bounded.sqlite');
  const holder = new DatabaseSync(file);
  const contender = new DatabaseSync(file);
  t.after(() => { holder.close(); contender.close(); });
  holder.exec('CREATE TABLE proof (n INTEGER); BEGIN IMMEDIATE');
  contender.exec('PRAGMA busy_timeout=1');
  const old = process.env.PULLBOARD_BOARD_QUEUE_MS;
  delete process.env.PULLBOARD_BOARD_QUEUE_MS;
  try {
    assert.throws(() => store.beginImmediateQueued(contender, Date.now() - 10_000), { code: 'BOARD_BUSY' });
    assert.equal(contender.prepare('PRAGMA busy_timeout').get().timeout, 1);
  } finally {
    if (old === undefined) delete process.env.PULLBOARD_BOARD_QUEUE_MS;
    else process.env.PULLBOARD_BOARD_QUEUE_MS = old;
  }
  holder.exec('ROLLBACK');
});

test('submit dry-run prepares repository evidence before locking and records a hold below 500 ms [C7]', t => {
  privateHome(t);
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'busy-retry-fixture';
  const box = helpers.project('true', sandbox, { withWorktree: false });
  const added = fixtureAdd(box.run, box.repo, 'web', 'Preflight lock measurement', '--specs', 'G1',
    '--criterion', 'The dry-run leaves no submission. [test]', '--check', 'true', '--route', 'strong', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  // @pullboard-board-file locking: the retry case needs a second connection contending on the same board file.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined,
    { gitRoot: box.repo, writeContext: { command: 'submit-preflight' } });
  t.after(() => closeBoard(board));
  const builder = store.register(board, { lane: 'web', path: join(box.dir, 'builder'), model: 'fixture', family: 'openai' });
  board.writeContext.seat = builder;
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000,
    freeze: () => ({ text: '{}', digest: 'private-preflight-fixture' }), head: box.git(box.repo, 'rev-parse', 'HEAD') });
  const observer = new DatabaseSync(join(box.repo, '.git/pullboard/board.sqlite'));
  observer.exec('PRAGMA busy_timeout=0');
  t.after(() => observer.close());
  const policyReads = board.enginePorts.sandboxPolicyReads;
  let policyProbes = 0;
  board.enginePorts = { ...board.enginePorts, sandboxPolicyReads: { ...policyReads,
    /** Probe the actual policy read while preserving its production authority. */
    mainPolicy(root) {
    observer.exec('BEGIN IMMEDIATE; ROLLBACK');
    policyProbes++;
    return policyReads.mainPolicy(root);
  } } };
  let preparations = 0;
  const ports = {
    atomic: store.atomic, submit: store.submit,
    /** Delegate real preparation while proving no outer writer has been acquired. */
    prepareSubmit(current, item, options) {
      observer.exec('BEGIN IMMEDIATE; ROLLBACK');
      preparations++;
      return store.prepareSubmit(current, item, options);
    },
  };
  const before = store.getItem(board, id);
  const commit = box.git(box.repo, 'rev-parse', 'HEAD');
  submitPreflight(board, id, { agentId: builder, commit, tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') }, ports);
  assert.ok(policyProbes > 0, 'actual accepted-policy preparation permits an independent writer');
  assert.equal(preparations, 1, 'repository preparation runs outside the outer dry-run transaction');
  assert.deepEqual(store.getItem(board, id), before, 'the dry-run still rolls native state back');
  const rows = readFileSync(store.boardWriteLog(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const hold = rows.filter(row => row.command === 'submit-preflight' && row.outcome === 'rolled-back').at(-1);
  assert.ok(hold, 'the completed dry-run has a per-command measurement');
  assert.ok(hold.durationMs < 500, `submit preflight held the writer for ${hold.durationMs}ms`); // budget: declared measurement ceiling in frozen #2847 writer-hold bar.
});

test('submit dry-run prepares again when another seat commits after preparation, and stays bounded [C7]', t => {
  privateHome(t);
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'busy-retry-fixture';
  const box = helpers.project('true', sandbox, { withWorktree: false });
  const added = fixtureAdd(box.run, box.repo, 'web', 'Preflight stale snapshot', '--specs', 'G1',
    '--criterion', 'The dry-run leaves no submission. [test]', '--check', 'true', '--route', 'strong', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const file = join(box.repo, '.git/pullboard/board.sqlite');
  // @pullboard-board-file locking: the retry case needs a second connection contending on the same board file.
  const board = openBoard(file, undefined, { gitRoot: box.repo, writeContext: { command: 'submit-preflight' } });
  t.after(() => closeBoard(board));
  const builder = store.register(board, { lane: 'web', path: join(box.dir, 'builder'), model: 'fixture', family: 'openai' });
  board.writeContext.seat = builder;
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000,
    freeze: () => ({ text: '{}', digest: 'private-preflight-fixture' }), head: box.git(box.repo, 'rev-parse', 'HEAD') });
  const peer = new DatabaseSync(file);
  t.after(() => peer.close());
  let preparations = 0, pokes = 0;
  /** Another connection commits right after each of the first `stale` preparations, as a busy board does. */
  const ports = stale => ({
    atomic: store.atomic, submit: store.submit,
    /** Delegate real preparation, then let a peer commit before the dry-run transaction begins. */
    prepareSubmit(current, item, options) {
      preparations++;
      const prepared = store.prepareSubmit(current, item, options);
      if (preparations <= stale) peer.prepare("INSERT OR REPLACE INTO board_meta(meta_key, meta_value) VALUES ('fixture:peer-write', ?)").run(String(++pokes));
      return prepared;
    },
  });
  const before = store.getItem(board, id);
  const submission = { agentId: builder, commit: box.git(box.repo, 'rev-parse', 'HEAD'), tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') };
  submitPreflight(board, id, submission, ports(1));
  assert.equal(preparations, 2, 'one stale snapshot is prepared again, then the dry-run passes');
  assert.deepEqual(store.getItem(board, id), before, 'the dry-run still rolls native state back');
  preparations = 0;
  assert.throws(() => submitPreflight(board, id, submission, ports(Infinity)),
    error => error.code === 'BOARD_BUSY' && /changed while preparing submit/u.test(error.message));
  assert.equal(preparations, 6, 'a board that changes on every attempt is refused after a bounded number of preparations');
});
