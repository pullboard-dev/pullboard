/** Closing a fixed Main red tells each open item whose red gate failed on it, once [C7,#1269]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { updateMainReds } from '../../../src/io/test/main-reds.js';

const FILE = 't/a.test.js';

/** A repository with the test file committed, an open Main red item row for it, and ports that record every ordered move and apply the withdraw to the row. */
function world(t) {
  const box = privateFixtureFiles('pullboard-main-reds-notify-');
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  box.write(`repo/${FILE}`, "import { test } from 'node:test';\ntest('x', () => {});\n");
  fixtureCommitAll(`${box.root}/repo`);
  const red = 41;
  const rows = [{ item_id: red, item_title: `Main red: ${FILE}`, item_status: 'open', item_merged_commit: null,
    item_criterion: 'Repair these exact cases on main ' + 'a'.repeat(40) + ': case one; case two. They fail in a test run at main alone.' }];
  const moves = [];
  const itemReds = [
    { id: 7, failures: [{ file: FILE, name: 'case one' }] },
    { id: 8, failures: [{ file: 't/other.test.js', name: 'case one' }] },
    { id: 9, failures: [{ file: FILE, name: 'a case the red does not list' }] },
  ];
  const ports = {
    itemReds: () => itemReds,
    withBoard: (ctx, work) => work({}),
    withBoardRead: (ctx, work) => work({}),
    listItems: () => rows,
    ordered: async (ctx, target, operation, args) => {
      moves.push({ operation, id: args[0], text: args[1]?.text ?? args[1]?.reason });
      if (operation === 'withdraw') rows[0].item_status = 'withdrawn';
    },
  };
  const ctx = { info: { root: `${box.root}/repo` }, config: { lanes: [] } };
  const run = () => updateMainReds({ err() {} }, ctx, { green: true, files: [FILE], cases: [], run: 'run-1' }, ports);
  return { red, moves, run };
}

test('cli.test-main-reds.notifies-failed-items: clause 1: updateMainReds, closing a fixed Main red, appends one note on each open item whose red gate failed on its file and case, naming the file, the main commit and the next step [C7,#1269]', async t => {
  const { red, moves, run } = world(t);
  const made = await run();
  assert.deepEqual(made.closed, [red]);
  const notes = moves.filter(move => move.operation === 'appendFact' && move.id !== red);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, 7);
  assert.match(notes[0].text, new RegExp(`${FILE} is fixed on main [a-f0-9]{12} .*resubmit or rerun the gate`, 'u'));
});

test('cli.test-main-reds.skips-other-items-and-repeats: clause 2: an item whose red failures name another file or case gets no note, and a second run that closes nothing writes no duplicate note [C7,#1269]', async t => {
  const { red, moves, run } = world(t);
  await run();
  assert.deepEqual(moves.filter(move => move.operation === 'appendFact' && [8, 9].includes(move.id)), [], 'items 8 and 9 failed another file or case');
  const before = moves.length;
  const again = await run();
  assert.deepEqual(again.closed, [], 'the second run closes nothing');
  assert.equal(moves.length, before, 'and writes no note');
  assert.equal(moves.filter(move => move.id === 7).length, 1);
  assert.ok(red);
});
