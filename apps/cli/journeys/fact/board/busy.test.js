/** @pullboard-test-input apps/cli/pullboard.js apps/lib/index.js packages/git/index.js packages/store/index.js */
/** @pullboard-test-loads packages/store/src/io/board.js */
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  join,
  resolve,
} from 'node:path';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { boardWriteHolderText } from '../../../../../packages/store/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { beginCommandPhase } from '../../../../../packages/link/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import {
  runFixtureChild,
  startFixtureChild,
} from '../../../tests/fixtures/child.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';

// Process-level: the remaining launches here run preloads, IPC lock holders, installed copies and other-process
// SQLite contention, none of which an in-process call can reproduce.
const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Snapshot the real private board without acquiring a write lock. */
function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return exportBoard({ db }, { beginCommandPhase }); }
  finally { db.close(); }
}

/** Hold only this test's SQLite write lock until the parent explicitly releases it. */
async function holdWriteLock(box, file) {
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE');
    /** Release the private lock on request or loss of its owning parent. */
    function release() {
      db.exec('ROLLBACK');
      db.close();
      process.removeListener('disconnect', release);
      if (process.connected) process.disconnect();
    }
    process.once('disconnect', release);
    process.once('message', release);
    process.send({ kind: 'locked' });
  `;
  const child = startFixtureChild(process.execPath, ['--input-type=module', '-e', source, file], {
    cwd: box.repo, env: box.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = new Promise((resolveClosed) => child.once('close', (code, signal) => resolveClosed({ code, signal })));
  await new Promise((resolveReady, rejectReady) => {
    child.once('error', rejectReady);
    child.once('close', (code, signal) => rejectReady(new Error(`private lock holder exited before readiness: ${code}/${signal}`)));
    child.on('message', (message) => { if (message?.kind === 'locked') resolveReady(); });
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (child.connected) child.send({ kind: 'release' });
    const result = await closed;
    assert.deepEqual(result, { code: 0, signal: null }, child.fixtureFailure);
  };
}

/** Prove a real ordered CLI move refuses contention atomically, then succeeds exactly once. */
async function proveBusyWrite(t, args, table, events = 1) {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = snapshot(file);
  const release = await holdWriteLock(box, file);
  t.after(release);
  const refused = await runCliInProcess([...args, '--json'], { cwd: box.repo, env: box.env });
  assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
  const output = `${refused.stdout}\n${refused.stderr}`;
  assert.match(output, /BOARD_BUSY/u, output);
  const document = JSON.parse(refused.stdout);
  assert.equal(document.error.code, 'BOARD_BUSY');
  assert.match(document.error.message, /remained held by another process after \d+ms/u);
  assert.ok(document.error.message.includes(file), document.error.message);
  assert.match(document.error.next, /retry/u);
  assert.doesNotMatch(output, /Error: database is locked|\n\s+at (?:\S+\s+\()?file:|ERR_SQLITE_ERROR/u);
  assert.deepEqual(snapshot(file), before, 'refused move must not partially change any board table');
  await release();
  const retried = await runCliInProcess([...args, '--json'], { cwd: box.repo, env: box.env });
  assert.equal(retried.status, 0, `${retried.stdout}${retried.stderr}`);
  const after = snapshot(file);
  assert.equal(after.tables[table].length, before.tables[table].length + 1, 'one retry makes exactly one move');
  assert.equal(after.tables.event.length, before.tables.event.length + events, 'only the successful retry records its events');
}

test('a board write that outwaits the busy timeout is refused by name, never a stack trace [C7,P4,B2]', async (t) => {
  await proveBusyWrite(t, ['shout', 'all', 'private busy shout'], 'shout');
});

test('a busy ordered item addition leaves no partial item and retries once [C7,P4,B2]', async (t) => {
  await proveBusyWrite(t, ['add', 'web', 'private busy item', '--specs', 'G1', '--criterion', 'the page renders'], 'item', 2); // an add records [add, milestone_placed]
});

/** Hold a public store transaction, with an explicit diagnostic identity, until its owner releases it. */
async function holdNamedWriter(box, file) {
  const releaseFile = join(box.dir, 'release-named-board-writer');
  const source = `
    import * as store from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
    import { openBoard } from ${JSON.stringify(new URL('../../../../lib/index.js', import.meta.url).href)};
    import { existsSync } from 'node:fs';
    const board = openBoard(process.argv[1], undefined, {
      writeContext: { command: 'private-lock-holder', seat: 'coordinator' },
    });
    try {
      store.atomic(board, () => {
        process.send({ kind: 'locked' });
        const deadline = Date.now() + 30_000; // budget: bound an owned fixture covering the real 10 s SQLite busy timeout.
        while (!existsSync(process.argv[2])) {
          if (Date.now() >= deadline) throw new Error('private lock owner was not released');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      });
    } finally {
      store.closeBoard(board);
      if (process.connected) process.disconnect();
    }
  `;
  const child = startFixtureChild(process.execPath, ['--input-type=module', '-e', source, file, releaseFile], {
    cwd: box.repo, env: box.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolveClosed => child.once('close', (code, signal) => resolveClosed({ code, signal })));
  let released = false;
  /** Close and drain only the private holder started above, never another writer or SQLite lock file. */
  async function release() {
    if (!released) { released = true; writeFileSync(releaseFile, 'release\n'); }
    const result = await closed;
    assert.deepEqual(result, { code: 0, signal: null }, stderr || child.fixtureFailure);
  }
  try {
    await new Promise((resolveReady, rejectReady) => {
      child.once('error', rejectReady);
      child.once('close', (code, signal) => rejectReady(new Error(`private named writer exited before readiness: ${code}/${signal}`)));
      child.on('message', message => { if (message?.kind === 'locked') resolveReady(); });
    });
  } catch (error) {
    await release();
    throw error;
  }
  return { pid: child.pid, release, stderr: () => stderr };
}

test('a refused writer names the board lock holder [C7,P4,B2]', async t => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = snapshot(file);
  const holder = await holdNamedWriter(box, file);
  t.after(holder.release);
  let message;
  try {
    const refused = await runCliInProcess(['shout', 'all', 'private named-holder contention', '--json'], { cwd: box.repo, env: box.env });
    assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
    const document = JSON.parse(refused.stdout);
    assert.equal(document.error.code, 'BOARD_BUSY');
    message = document.error.message;
    assert.deepEqual(snapshot(file), before, 'contention leaves all native board tables unchanged');
  } finally {
    await holder.release();
  }
  assert.match(message, /waiting or holding/u, 'pre-BEGIN markers are explicitly advisory contenders');
  assert.match(message, /private-lock-holder/u, 'the refusal names the real instrumented command');
  assert.match(message, /coordinator/u, 'the refusal names the real holder seat');
  assert.match(message, new RegExp(String.raw`\b${holder.pid}\b`, 'u'), 'the refusal names the live holder PID');
  const lines = holder.stderr().split('\n').filter(line => line.startsWith('pullboard: long board write '));
  assert.equal(lines.length, 1, 'only the outer transaction emits one long-write line');
  const record = JSON.parse(lines[0].slice('pullboard: long board write '.length));
  assert.equal(record.command, 'private-lock-holder');
  assert.equal(record.seat, 'coordinator');
  assert.equal(record.pid, holder.pid);
  assert.ok(record.durationMs > 2_000, 'the real busy timeout held the writer longer than the declared 2 s threshold'); // budget: declared #1197 over-2s logging threshold.
});


/** Read only the product's structured long-write diagnostic, leaving other stderr intact. */
function longWrites(stderr) {
  return stderr.split('\n').filter(line => line.startsWith('pullboard: long board write '))
    .map(line => JSON.parse(line.slice('pullboard: long board write '.length)));
}

test('a nested rolled-back writer logs once and leaves no live advisory record [C7,P4,B2]', () => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = snapshot(file);
  const source = `
    import * as store from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
    import { openBoard } from ${JSON.stringify(new URL('../../../../lib/index.js', import.meta.url).href)};
    const board = openBoard(process.argv[1], undefined, { writeContext: { command: 'private-rollback', seat: 'coordinator' } });
    try {
      store.atomic(board, () => store.atomic(board, () => {
        // budget: a genuine held write must cross the product's two-second diagnostic threshold.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_100);
        throw new Error('private rollback control');
      }));
    } catch (error) {
      if (error.message !== 'private rollback control') throw error;
    } finally { store.closeBoard(board); }
  `;
  // Process-level: a real process holds the board write, so its pid, stderr diagnostic and exit status are what is asserted.
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, file], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.context);
  const records = longWrites(result.stderr);
  assert.equal(records.length, 1, 'nested savepoints do not duplicate the outer hold');
  assert.equal(records[0].command, 'private-rollback');
  assert.equal(records[0].outcome, 'rolled-back');
  assert.ok(records[0].durationMs > 2_000); // budget: declared #1197 over-2s logging threshold.
  assert.equal(boardWriteHolderText(file), '', 'released writers do not remain current');
  assert.deepEqual(snapshot(file), before, 'diagnostic metadata never changes native board state');
  const stale = join(file + '.write-holders', `${process.pid}-deadbeef.json`);
  writeFileSync(stale, JSON.stringify({ version: 1, pid: process.pid, started: 'not this process start',
    processSha256: 'a'.repeat(64), command: 'stale-private-writer', seat: 'coordinator', acquiredAt: Date.now() }));
  assert.equal(boardWriteHolderText(file), '', 'a reused PID without matching identity is not a current holder');
});



test('a standalone native attempt and nested rollback each observe only their actual outer write [C7,P4]', async () => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'private native attempt', '--specs', 'G1', '--criterion', 'the private page renders', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  for (const rollback of [false, true]) {
    const source = `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import * as store from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
    import { openBoard } from ${JSON.stringify(new URL('../../../../lib/index.js', import.meta.url).href)};
      import { exportBoard } from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
      import { boardWriteHolderText } from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
      const file = process.argv[1];
      const board = openBoard(file, undefined, { writeContext: { command: 'private-attempt', seat: 'coordinator' } });
      const before = exportBoard(board);
      let held = false;
      let contenderCode = null;
      let holderText = null;
      board.db.function('hold_private_attempt', () => {
        held = true;
        const contender = new DatabaseSync(file);
        try {
          contender.exec('PRAGMA busy_timeout=0');
          try { contender.exec('BEGIN IMMEDIATE'); contender.exec('ROLLBACK'); }
          catch (error) { contenderCode = error.errcode & 255; }
        } finally { contender.close(); }
        holderText = boardWriteHolderText(file);
        // budget: pause after actual event INSERT owns the write lock, across the declared diagnostic threshold.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_100);
        return 1;
      });
      board.db.exec('CREATE TEMP TRIGGER hold_private_attempt BEFORE INSERT ON main.event BEGIN SELECT hold_private_attempt(); END');
      try {
        if (${rollback}) {
          assert.throws(() => store.atomic(board, () => {
            store.recordAttempt(board, ${id}, { agentId: 'coordinator', n: 1, seconds: 0, result: 'private attempt' });
            throw new Error('private outer rollback');
          }), /private outer rollback/);
          assert.deepEqual(exportBoard(board), before);
        } else {
          store.recordAttempt(board, ${id}, { agentId: 'coordinator', n: 1, seconds: 0, result: 'private attempt' });
          const after = exportBoard(board);
          assert.deepEqual(after.tables.event.slice(0, before.tables.event.length), before.tables.event);
          assert.equal(after.tables.event.length, before.tables.event.length + 1);
          assert.equal(after.tables.event.at(-1).event_kind, 'attempt');
        }
        assert.equal(held, true);
        assert.equal(contenderCode, 5, 'assert outside the SQLite callback so an assertion cannot be swallowed');
        assert.equal(boardWriteHolderText(file), '');
        process.stdout.write(JSON.stringify({ pid: process.pid, holderText, contenderCode }));
      } finally { store.closeBoard(board); }
    `;
    // Process-level: a real process is the contender, so its pid, holder identity and cleanup on refusal are observed.
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, file], {
      cwd: box.repo, env: box.env, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.context);
    const observed = JSON.parse(result.stdout);
    const records = longWrites(result.stderr);
    assert.equal(records.length, 1, 'standalone and nested event paths each have one actual outer observation');
    assert.equal(records[0].command, 'private-attempt');
    assert.equal(records[0].seat, 'coordinator');
    assert.equal(records[0].pid, observed.pid);
    assert.equal(records[0].outcome, rollback ? 'rolled-back' : 'committed');
    assert.ok(records[0].durationMs > 2_000); // budget: declared #1197 diagnostic threshold.
    assert.match(observed.holderText, /private-attempt/);
    assert.match(observed.holderText, new RegExp(String.raw`\b${observed.pid}\b`, 'u'));
    assert.equal(observed.contenderCode, 5);
  }
});
