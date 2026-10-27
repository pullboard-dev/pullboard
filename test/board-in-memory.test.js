/** @pullboard-test-input test-tree */
/** Production SQLite schema and move contracts stay identical without board files [C7,B2,M1,H16]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { fixtureBoard } from './board-fixture.js';
import { boardFileOpens, boardFileProblems, boardFileReport } from '../bin/checks/board-files.js';

const AT = '2026-10-27T00:00:00.000Z';
const clock = { now: () => new Date(AT) };

/** Read persistent declarations and version stamps, including every production constraint. */
function schema(board) {
  return {
    declarations: board.db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
    version: board.db.prepare('PRAGMA user_version').get(),
    application: board.db.prepare('PRAGMA application_id').get(),
  };
}

/** Exercise actual guarded writes, refusal rollback and replay without Git or a CLI process. */
function moves(board) {
  store.register(board, { lane: 'coordinator', path: '/fixture' });
  const builder = store.register(board, { lane: 'web', path: '/fixture/web' });
  store.register(board, { lane: 'web', path: '/fixture/web-2' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Memory contract' });
  const move = prepareEngineMove(board, 'claim', [id, { agentId: builder, lane: 'web', leaseMs: 7_200_000,
    freeze: () => ({ text: 'fixed criterion', digest: 'a'.repeat(64) }) }], { id: 'memory-contract-claim' });
  const receipt = { sequence: 1, at: AT };
  const claimed = applyEngineMove(board, move, receipt);
  assert.equal(claimed.error, undefined);
  assert.equal(store.getItem(board, id).item_status, 'claimed');
  assert.equal(store.getItem(board, id).item_owner, builder);
  const before = store.events(board).length;
  assert.deepEqual(applyEngineMove(board, move, receipt), claimed, 'a duplicate returns the original result');
  assert.equal(store.events(board).length, before, 'replay adds no event');
  assert.throws(() => store.claim(board, id, { agentId: 'web-2', lane: 'web', leaseMs: 7_200_000,
    freeze: () => ({ text: 'replacement', digest: 'b'.repeat(64) }) }), /HELD/u);
  assert.equal(store.events(board).length, before, 'a refused move has no partial effect');
  assert.throws(() => board.db.prepare("UPDATE item SET item_status='open' WHERE item_id=?").run(id), /STATUS_OUTSIDE_MOVE/u);
  store.release(board, id, builder);
  const item = store.getItem(board, id);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_owner, null);
  return { item, events: store.events(board).map(event => ({ kind: event.event_kind, by: event.event_by, at: event.event_at })) };
}

test('memory and file boards share the production schema and guarded move contract [C7,B2,M1,H16]', async t => {
  let expected;
  for (const storage of ['memory', 'file']) {
    await t.test(`${storage} SQLite runs the same contract [C7,B2,M1,H16]`, subtest => {
      const options = storage === 'memory' ? { clock } : { clock, storage, purpose: 'persistence' };
      const board = fixtureBoard(subtest, options);
      const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
      assert.equal(file === '', storage === 'memory');
      const result = { schema: schema(board), moves: moves(board) };
      if (expected) assert.deepEqual(result, expected);
      else expected = result;
      if (storage === 'file') {
        assert.equal(existsSync(file), true);
        const persisted = store.openBoardReadOnly(file);
        try { assert.equal(persisted.prepare('SELECT item_status FROM item').get().item_status, 'open'); }
        finally { persisted.close(); }
      }
    });
  }
});

test('memory fixture connections are independent and unsupported storage fails closed [C7,B2]', t => {
  const one = fixtureBoard(t);
  const two = fixtureBoard(t);
  one.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('fixture_private', 'one');
  assert.equal(two.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('fixture_private'), undefined);
  for (const options of [{ storage: 'shared' }, { storage: 'file' }, { storage: 'file', purpose: 'logic' },
    { storage: 'memory', purpose: 'persistence' }]) {
    assert.throws(() => fixtureBoard(t, options), { code: 'TEST_BOARD_STORAGE' });
  }
});

test('the board-file lint names direct, namespaced and aliased logic file opens [C7]', () => {
  const source = [
    "import { openBoard as open } from '../src/board.js';",
    "const a = store.openBoard(':memory:');",
    "const b = openBoard(file);",
    "const c = open(join(root, 'board.sqlite'));",
    "const d = store.openBoard(`:memory:`);",
    "// store.openBoard('ignored.sqlite');",
    'const text = "openBoard(file)";',
    '// @pullboard-board-file locking: a competing connection must see the lock',
    'const e = openBoard(file);',
    "const f = openBoard(':memory:' + suffix);",
  ].join('\n');
  assert.deepEqual(boardFileOpens(source, 'test/example.test.js').map(({ path, line }) => ({ path, line })), [
    { path: 'test/example.test.js', line: 3 }, { path: 'test/example.test.js', line: 4 },
    { path: 'test/example.test.js', line: 10 },
  ]);
  assert.equal(boardFileOpens('// @pullboard-board-file logic: not a boundary\nopenBoard(file)', 'test/logic.test.js').length, 1);
});

test('the board-file debt ratchet names outstanding tests and prevents new logic file opens [C7]', () => {
  const root = join(import.meta.dirname, '..');
  const baseline = JSON.parse(readFileSync(join(import.meta.dirname, 'board-files-baseline.json'), 'utf8'));
  assert.deepEqual(boardFileProblems(root, baseline), []);
  const debt = boardFileReport(root);
  assert.ok(debt.every(row => /\.(?:test|spec)\.[cm]?js$/u.test(row.path) && row.line > 0));
  if (debt.length) {
    const tightened = { ...baseline, [debt[0].path]: 0 };
    assert.ok(boardFileProblems(root, tightened).some(row => row.path === debt[0].path));
  }
  for (const path of ['test/engine.test.js', 'test/item-notes-engine.test.js']) {
    assert.equal(debt.some(row => row.path === path), false, `${path} has no remaining board-file opens`);
  }
});
