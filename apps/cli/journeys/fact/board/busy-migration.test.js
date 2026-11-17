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
import { prepareBoardWriteIdentity } from '../../../../../packages/store/index.js';
import { prepareBoardWriteMarker } from '../../../../../packages/store/src/io/board/write/lock.js';
import { discardBoardWriteMarker } from '../../../../../packages/store/src/io/board/write/lock.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { beginCommandPhase } from '../../../../../packages/link/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

// Process-level: these launches run real processes that own the board handle, installed copies and other-process
// SQLite contention, none of which an in-process call can reproduce.
const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Snapshot the real private board without acquiring a write lock. */
function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return exportBoard({ db }, { beginCommandPhase }); }
  finally { db.close(); }
}

/** Read only the product's structured long-write diagnostic, leaving other stderr intact. */
function longWrites(stderr) {
  return stderr.split('\n').filter(line => line.startsWith('pullboard: long board write '))
    .map(line => JSON.parse(line.slice('pullboard: long board write '.length)));
}

test('native import observes committed and rolled-back write ownership without changing restored rows [A7,C7,P4]', async () => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'private restored item', '--specs', 'G1', '--criterion', 'the private page renders', '--json');
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
    // Process-level: a real process owns the board handle, so write ownership and its process identity are observed from outside.
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
  // Process-level: a real process runs the journal conversion, so its exit status and stderr diagnostic are what is asserted.
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
  const db = new DatabaseSync(file);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'event_fact_%_v2'").all();
  try {
    assert.equal(indexes.length, 3);
    for (const index of indexes) db.exec(`DROP INDEX "${index.name}"`);
    db.exec("UPDATE board_meta SET meta_value = '0' WHERE meta_key = 'event_log_version'; PRAGMA application_id=0");
  } finally { db.close(); }
  const before = snapshot(file); // taken after the downgrade, so the rollback is compared with the board it started from
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
  // Process-level: a --import preload and the installed copy's own entry run in a real process; its exit status and rollback after failure are asserted.
  const result = runFixtureChild(process.execPath, ['--import', preload, join(installed, 'apps/cli/pullboard.js'), 'shout', 'all', 'must roll back', '--json'], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /private migration rollback/);
  assert.deepEqual(snapshot(file), before, 'native rows remain unchanged after failed schema work');
  const unchanged = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(unchanged.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'event_log_version'").get().meta_value, '0');
    assert.equal(unchanged.prepare('PRAGMA application_id').get().application_id, 0);
    assert.equal(unchanged.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'event_fact_%_v2'").get().n, 0);
  } finally { unchanged.close(); }
  assert.equal(boardWriteHolderText(file), '');
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
