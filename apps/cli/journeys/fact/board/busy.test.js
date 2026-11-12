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
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mappedWorkingSource } from '../../../../../packages/gate/src/io/scan.js';
import { boardWriteHolderText } from '../../../../../packages/store/index.js';
import { prepareBoardWriteIdentity } from '../../../../../packages/store/index.js';
import { prepareBoardWriteMarker } from '../../../../../packages/store/src/io/board/write/lock.js';
import { discardBoardWriteMarker } from '../../../../../packages/store/src/io/board/write/lock.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { beginCommandPhase } from '../../../../../packages/link/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import {
  runFixtureChild,
  startFixtureChild,
} from '../../../tests/fixtures/child.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

// Process-level: the remaining launches here run preloads, IPC lock holders, installed copies and other-process
// SQLite contention, none of which an in-process call can reproduce.
const e2e = createE2eHelpers();
after(e2e.cleanup);
const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

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
  const refused = runFixtureChild(process.execPath, [BIN, ...args, '--json'], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(refused.status, 1, refused.context);
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
  const retried = runFixtureChild(process.execPath, [BIN, ...args, '--json'], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(retried.status, 0, retried.context);
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
    const refused = runFixtureChild(process.execPath, [BIN, 'shout', 'all', 'private named-holder contention', '--json'], {
      cwd: box.repo, env: box.env, encoding: 'utf8',
    });
    assert.equal(refused.status, 1, refused.context);
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

test('a real CLI writer labels its long transaction without changing JSON or native counts [C7,P4,B2]', () => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = snapshot(file);
  const preload = join(box.dir, 'hold-private-shout.mjs');
  writeFileSync(preload, `
    import { DatabaseSync } from 'node:sqlite';
    const prepare = DatabaseSync.prototype.prepare;
    let delayed = false;
    /** Delay one actual private shout insertion after its outer transaction has acquired the lock. */
    DatabaseSync.prototype.prepare = function(sql, ...args) {
      const statement = prepare.call(this, sql, ...args);
      if (!sql.includes('INSERT INTO shout')) return statement;
      const run = statement.run;
      statement.run = function(...values) {
        if (!delayed) {
          delayed = true;
          // budget: exercise the genuine long-hold diagnostic, not a performance assertion.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_100);
        }
        return run.apply(this, values);
      };
      return statement;
    };
  `);
  const result = runFixtureChild(process.execPath, ['--import', preload, BIN, 'shout', 'all', 'private timed shout', '--json'], {
    cwd: box.web, env: box.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.context);
  assert.equal(JSON.parse(result.stdout).version, 1, 'the diagnostic stays off JSON stdout');
  const records = longWrites(result.stderr);
  assert.equal(records.length, 1);
  assert.equal(records[0].command, 'shout');
  assert.equal(records[0].seat, 'web-1');
  assert.equal(records[0].outcome, 'committed');
  assert.ok(Number.isSafeInteger(records[0].pid));
  assert.ok(records[0].durationMs > 2_000); // budget: declared #1197 over-2s logging threshold.
  const after = snapshot(file);
  assert.equal(after.tables.shout.length, before.tables.shout.length + 1);
  assert.equal(after.tables.event.length, before.tables.event.length + 1);
  assert.equal(boardWriteHolderText(file), '');
});

test('opening an older board names and logs its genuine index-building write [C7,P4,B2]', async (t) => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  // Installed source may own a main-board migration without entering the small project's Git history.
  const installed = join(box.dir, 'installed-maintenance-cli');
  mkdirSync(installed);
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), installed);
  const privateBin = join(installed, 'apps/cli/pullboard.js');
  assert.equal(box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-dir'),
    box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  assert.equal(readFileSync(privateBin, 'utf8'), readFileSync(BIN, 'utf8'));
  const sourceGit = mappedWorkingSource(resolve(import.meta.dirname, '../../../../..'), 'packages/git/index.js');
  const installedGit = {
    body: readFileSync(join(installed, sourceGit.implementationPath)),
    shimBody: sourceGit.shimBody === null ? null : readFileSync(join(installed, sourceGit.shimPath)),
  };
  assert.deepEqual(installedGit.body, sourceGit.body, 'the installed implementation retains exact source Buffer bytes');
  assert.deepEqual(installedGit.shimBody, sourceGit.shimBody, 'the installed compatibility shim retains exact source bytes');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'private maintenance item', '--specs', 'G1', '--criterion', 'the private page renders', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const fact = await box.runLocal(box.repo, 'fact', String(id), 'note', 'private native index input', '--json');
  assert.equal(fact.code, 0, fact.err);
  const before = snapshot(file);
  const fixture = new DatabaseSync(file);
  const indexes = fixture.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'event_fact_%_v2' ORDER BY name").all();
  const version = fixture.prepare('PRAGMA user_version').get().user_version;
  const stamp = fixture.prepare('PRAGMA application_id').get().application_id;
  try {
    assert.equal(indexes.length, 3);
    for (const index of indexes) fixture.exec(`DROP INDEX "${index.name}"`);
    fixture.exec(`PRAGMA user_version = ${version - 1}; PRAGMA application_id = 0`);
  } finally { fixture.close(); }
  const releaseFile = join(box.dir, 'release-private-index');
  const preload = join(box.dir, 'hold-private-index.mjs');
  writeFileSync(preload, `
    import { DatabaseSync } from 'node:sqlite';
    import { existsSync } from 'node:fs';
    const originalExec = DatabaseSync.prototype.exec;
    const reference = new DatabaseSync(':memory:');
    let registered = false;
    let held = false;
    /** Pause inside actual SQLite index evaluation, preserving reference SQLite JSON semantics. */
    DatabaseSync.prototype.exec = function(sql, ...args) {
      if (!registered && sql.includes('CREATE INDEX IF NOT EXISTS event_fact_identity_v2')) {
        registered = true;
        /** Preserve SQLite's extraction result while the first evaluation exercises the real lock. */
        function extractIdentity(value, path) {
          if (!held) {
            held = true;
            process.send({ kind: 'index-write-held' });
            const deadline = Date.now() + 30_000; // budget: bound cleanup of the owned private lock fixture.
            while (!existsSync(${JSON.stringify(releaseFile)})) {
              if (Date.now() >= deadline) throw new Error('private index writer was not released');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            }
          }
          return reference.prepare('SELECT json_extract(?, ?) AS value').get(value, path).value;
        }
        this.function('json_extract', { deterministic: true }, extractIdentity);
      }
      return originalExec.call(this, sql, ...args);
    };
  `);
  const child = startFixtureChild(process.execPath, ['--import', preload, privateBin, 'shout', 'all', 'private maintenance move', '--json'], {
    cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolveClosed => child.once('close', (code, signal) => resolveClosed({ code, signal })));
  let released = false;
  /** Release and drain only the CLI this fixture owns, including on an assertion failure. */
  async function release() {
    if (!released) { released = true; writeFileSync(releaseFile, 'release\n'); }
    const result = await closed;
    assert.deepEqual(result, { code: 0, signal: null }, `${stdout}\n${stderr}`.trim() || child.fixtureFailure);
  }
  t.after(release);
  await new Promise((resolveReady, rejectReady) => {
    child.once('error', rejectReady);
    child.once('close', (code, signal) => rejectReady(new Error(`private maintenance exited before index evaluation: ${code}/${signal}: ${stdout}\n${stderr}`)));
    child.on('message', message => { if (message?.kind === 'index-write-held') resolveReady(); });
  });
  const contender = new DatabaseSync(file);
  try {
    contender.exec('PRAGMA busy_timeout = 0');
    assert.throws(() => contender.exec('BEGIN IMMEDIATE'), error => (error.errcode & 0xff) === 5,
      'index evaluation must hold the genuine SQLite write lock, not merely sleep before SQL');
  } finally { contender.close(); }
  const heldText = boardWriteHolderText(file);
  await new Promise(resolveDelay => setTimeout(resolveDelay, 2_100)); // budget: exercise the declared over-2s write diagnostic.
  await release();
  assert.equal(JSON.parse(stdout).version, 1, 'maintenance diagnostics stay off JSON stdout');
  const records = longWrites(stderr);
  assert.equal(records.length, 1, 'one real behind-schema index transaction must log its long write');
  assert.equal(records[0].command, 'shout');
  assert.equal(records[0].seat, 'coordinator');
  assert.equal(records[0].pid, child.pid);
  assert.ok(records[0].durationMs > 2_000); // budget: declared #1197 over-2s logging threshold.
  assert.ok(heldText.includes('shout') && heldText.includes('coordinator'), heldText);
  assert.equal(boardWriteHolderText(file), '');
  const after = snapshot(file);
  for (const [name, rows] of Object.entries(before.tables)) {
    if (name === 'sqlite_sequence') {
      const sequences = Object.fromEntries(rows.map(row => [row.name, row.seq]));
      for (const table of ['event', 'shout']) sequences[table] = (sequences[table] ?? 0) + 1;
      assert.deepEqual(after.tables[name].map(row => [row.name, row.seq]), Object.entries(sequences).sort());
      continue;
    }
    assert.deepEqual(after.tables[name].slice(0, rows.length), rows, `existing native ${name} rows survive maintenance`);
    assert.equal(after.tables[name].length, rows.length + (['event', 'shout'].includes(name) ? 1 : 0));
  }
  const upgraded = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, version);
    assert.equal(upgraded.prepare('PRAGMA application_id').get().application_id, stamp);
    assert.deepEqual(upgraded.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'event_fact_%_v2' ORDER BY name").all(), indexes);
  } finally { upgraded.close(); }
});


test('native import observes committed and rolled-back write ownership without changing restored rows [A7,C7,P4]', () => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const added = fixtureAdd(box.run, box.repo, 'web', 'private restored item', '--specs', 'G1', '--criterion', 'the private page renders', '--json');
  assert.equal(added.code, 0, added.err);
  const document = snapshot(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  assert.equal(document.tables.item.length, 1);
  const input = join(box.dir, 'native-import.json');
  writeFileSync(input, JSON.stringify(document));
  for (const rollback of [false, true]) {
    const file = join(box.dir, `import-${rollback}.sqlite`);
    const source = `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      import * as store from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
    import { openBoard } from ${JSON.stringify(new URL('../../../../lib/index.js', import.meta.url).href)};
      import { exportBoard, importBoard } from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
      import { boardWriteHolderText } from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
      const file = process.argv[1];
      const document = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      const board = openBoard(file, undefined, { writeContext: { command: 'private-import', seat: 'coordinator' } });
      const before = exportBoard(board);
      let held = false;
      let contenderCode = null;
      let holderText = null;
      board.db.function('hold_private_import', () => {
        if (held) return 1;
        held = true;
        const contender = new DatabaseSync(file);
        try {
          contender.exec('PRAGMA busy_timeout=0');
          try { contender.exec('BEGIN IMMEDIATE'); contender.exec('ROLLBACK'); }
          catch (error) { contenderCode = error.errcode & 255; }
        } finally { contender.close(); }
        holderText = boardWriteHolderText(file);
        // budget: exercise the declared over-two-second diagnostic during a genuine native restore write.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_100);
        return 1;
      });
      board.db.exec("CREATE TEMP TRIGGER hold_private_import BEFORE INSERT ON main.item BEGIN SELECT hold_private_import(); ${rollback ? "SELECT RAISE(ABORT, 'private import rollback');" : ''} END");
      try {
        if (${rollback}) {
          assert.throws(() => importBoard(board, document), /private import rollback/);
          assert.deepEqual(exportBoard(board), before);
        } else {
          importBoard(board, document);
          assert.deepEqual(JSON.parse(JSON.stringify(exportBoard(board))), document);
        }
        assert.equal(held, true);
        assert.equal(contenderCode, 5, 'the native import held a genuine write lock');
        assert.match(holderText, /private-import/);
        assert.equal(boardWriteHolderText(file), '');
        process.stdout.write(JSON.stringify({ restored: !${rollback}, rolledBack: ${rollback} }));
      } finally { store.closeBoard(board); }
    `;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, file, input], {
      cwd: box.repo, env: box.env, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.context);
    assert.deepEqual(JSON.parse(result.stdout), { restored: !rollback, rolledBack: rollback });
    const records = longWrites(result.stderr);
    assert.equal(records.length, 1);
    assert.equal(records[0].command, 'private-import');
    assert.equal(records[0].seat, 'coordinator');
    assert.equal(records[0].outcome, rollback ? 'rolled-back' : 'committed');
    assert.ok(records[0].durationMs > 2_000); // budget: declared #1197 diagnostic threshold.
  }
});

test('journal conversion reports total wait-plus-hold separately and preserves its result [C7,P4]', () => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = snapshot(file);
  const source = `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { configureBoardJournal, boardWriteHolderText } from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
    const db = new DatabaseSync(process.argv[1]);
    const original = db.exec;
    const sentinel = new Error('private journal failure');
    for (const fail of [false, true]) {
      db.exec = function(sql) {
        assert.equal(sql, 'PRAGMA journal_mode = WAL');
        const result = original.call(this, sql);
        assert.equal(boardWriteHolderText(process.argv[1]), '');
        // budget: inject elapsed operation time, not a claimed SQLite held-lock duration.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_100);
        if (fail) throw sentinel;
        return result;
      };
      if (fail) assert.throws(() => configureBoardJournal(db, { command: 'private-journal', seat: 'coordinator' }), error => error === sentinel);
      else assert.equal(configureBoardJournal(db, { command: 'private-journal', seat: 'coordinator' }), undefined);
    }
    assert.throws(() => configureBoardJournal(db, null), error => error === sentinel,
      'invalid optional diagnostic context must preserve the original journal failure');
    db.close();
  `;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, file], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.context);
  assert.deepEqual(longWrites(result.stderr), []);
  const prefix = 'pullboard: long board operation ';
  const operations = result.stderr.split('\n').filter(line => line.startsWith(prefix))
    .map(line => JSON.parse(line.slice(prefix.length)));
  assert.equal(operations.length, 2);
  assert.deepEqual(operations.map(row => row.outcome), ['completed', 'failed']);
  for (const row of operations) {
    assert.equal(row.operation, 'journal_mode');
    assert.equal(row.timing, 'wait-plus-hold');
    assert.equal(row.command, 'private-journal');
    assert.equal(row.seat, 'coordinator');
    assert.ok(row.durationMs > 2_000); // budget: declared #1197 operation diagnostic threshold.
  }
  assert.deepEqual(snapshot(file), before);
});


test('a failed owning migration rolls back schema, index and stamp work together [A5,A6,C7]', () => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const installed = join(box.dir, 'installed-rollback-cli');
  mkdirSync(installed);
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), installed);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = snapshot(file);
  const db = new DatabaseSync(file);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'event_fact_%_v2'").all();
  try {
    assert.equal(indexes.length, 3);
    for (const index of indexes) db.exec(`DROP INDEX "${index.name}"`);
    db.exec(`PRAGMA user_version=${version - 1}; PRAGMA application_id=0`);
  } finally { db.close(); }
  const preload = join(box.dir, 'fail-private-index.mjs');
  writeFileSync(preload, `
    import { DatabaseSync } from 'node:sqlite';
    const original = DatabaseSync.prototype.exec;
    /** Fail only after genuine native index creation, while the outer migration still owns it. */
    DatabaseSync.prototype.exec = function(sql, ...args) {
      const result = original.call(this, sql, ...args);
      if (sql.includes('CREATE INDEX IF NOT EXISTS event_fact_identity_v2')) throw new Error('private migration rollback');
      return result;
    };
  `);
  const result = runFixtureChild(process.execPath, ['--import', preload, join(installed, 'apps/cli/pullboard.js'), 'shout', 'all', 'must roll back', '--json'], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /private migration rollback/);
  assert.deepEqual(snapshot(file), before, 'native rows remain unchanged after failed schema work');
  const unchanged = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, version - 1);
    assert.equal(unchanged.prepare('PRAGMA application_id').get().application_id, 0);
    assert.equal(unchanged.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'event_fact_%_v2'").get().n, 0);
  } finally { unchanged.close(); }
  assert.equal(boardWriteHolderText(file), '');
});


test('a standalone native attempt and nested rollback each observe only their actual outer write [C7,P4]', () => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const added = fixtureAdd(box.run, box.repo, 'web', 'private native attempt', '--specs', 'G1', '--criterion', 'the private page renders', '--json');
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


test('a pre-BEGIN contender is labelled waiting or holding and cleaned on refusal [C7,P4,B2]', t => {
  const box = e2e.project();
  const file = join(box.repo, '.git/pullboard/board.sqlite');
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  prepareBoardWriteIdentity();
  const marker = prepareBoardWriteMarker(db, { command: 'waiting-fixture', seat: 'core-waiter' });
  assert.ok(marker);
  assert.match(boardWriteHolderText(file), /waiting or holding/u);
  assert.match(boardWriteHolderText(file), /waiting-fixture/u);
  discardBoardWriteMarker(marker);
  assert.doesNotMatch(boardWriteHolderText(file), /waiting-fixture/u);
});
