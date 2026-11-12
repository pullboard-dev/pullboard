/** New work defaults to mid, so a plain add and the Main-red filer never refuse DIAGNOSIS_REQUIRED [C7,B13]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { defaultItemRoute } from '../../../../packages/items/index.js';
import { postLandSuite } from '../../../../packages/landing/index.js';
import { laneOf } from '../../../../packages/seats/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

/** A plain `add` that names no route: the shared fixture runner files bare adds as strong (#5428), so these cases spawn the CLI themselves. */
function plainAdd(helpers, box, ...args) {
  const result = runFixtureChild(process.execPath, [helpers.BIN, 'add', ...args], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr };
}

test('clause 1: an item with no route and no diagnosis defaults to mid, small or large [C7,B13]', () => {
  assert.equal(defaultItemRoute('the handler returns the canonical result [test]'), 'mid');
  assert.equal(defaultItemRoute(''), 'mid');
  assert.equal(defaultItemRoute('1. a [test]. 2. b [test]. 3. c [test].'), 'mid');
});

test('clause 2: the post-land Main-red filer files a Main red item on a board with diagnosis enabled [C7,H16]', async t => {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/default-route/main' });
  const folder = mkdtempSync(join(tmpdir(), 'default-route-mid-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const said = [];
  const state = { board, config: { lanes: { core: { owns: ['test/'] }, coordinator: { owns: ['docs/'] } }, affectedTests: 'node apps/cli/src/io/run/tests.js' },
    write: async (operation, [item]) => { assert.equal(operation, 'addItem'); return store.addItem(board, item); }, say: text => said.push(text), batch: null };
  const land = (id, failures) => {
    state.batch = { id, tip: `${id}`.padEnd(40, 'a'), root: folder, items: [{ id: 1 }] };
    return postLandSuite(state, { enabled: () => true, storePath: () => join(folder, 'result.json'), readItems: () => store.listItems(board), laneOf,
      unownedMainReds: store.unownedMainReds, runSuite: async () => ({ green: failures.length === 0, failures }) });
  };
  await land('b1', []);
  const result = await land('b2', [{ file: 'test/handler.test.js', name: 'the handler returns the canonical result' }]);
  assert.equal(result.error, undefined, said.join('\n'));
  assert.equal(result.filed.length, 1, said.join('\n'));
  const filed = store.getItem(board, result.filed[0].item);
  assert.equal(filed.item_title, 'Main red: test/handler.test.js');
  assert.equal(filed.item_route, 'mid');
});

test('clause 3: add --check with no --route succeeds and files mid work [C7,B13]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Default route fixture';
  const box = helpers.project('true', isolated);
  const added = plainAdd(helpers, box, 'web', 'Small correction', '--criterion', 'the handler returns the canonical result [test]', '--check', 'true',
    '--brief', 'Files: web/handler.js\nTest: test/handler.test.js asserts the canonical result', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(onBoard(box, board => store.getItem(board, id).item_route), 'mid');
});

test("clause 1: pullboard add with --check \"node apps/cli/src/io/run/tests.js 'test/x.test.js'\" and no brief succeeds with a brief naming the test [B14,C7,#3120]", t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox());
  const added = plainAdd(helpers, box, 'web', 'Quoted check', '--specs', 'G1', '--criterion', 'x passes [test]',
    '--check', "node apps/cli/src/io/run/tests.js 'test/x.test.js'", '--json');
  assert.equal(added.code, 0, added.out + added.err);
  const { item } = JSON.parse(added.out);
  assert.match(item.item_brief, /^Test: test\/x\.test\.js$/mu, item.item_brief);
  assert.equal(item.item_route, 'mid', 'an undiagnosed default starts mid, never a light add that refuses');
});
