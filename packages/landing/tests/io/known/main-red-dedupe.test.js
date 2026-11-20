/** Every Main red filer shares one cause key; the same cause adds a fact to its open repair and never files twice [B3,C7,H16,V4]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { auditFailureItem } from '../../../../items/index.js';
import { splitMainReds } from '../../../../items/index.js';
import { fileKnownMainReds } from '../../../src/io/known/main.js';
import { postLandSuite } from '../../../index.js';

const FILE = 'api/cases.test.js';
const stamp = '2026-11-12T10:00:00.000Z';

/** A real in-memory SQLite board with the coordinator seat; writes go through the store's own moves. */
function fixture(t) {
  const board = openCellBoard(':memory:', { now: () => new Date(stamp) });
  t.after(() => store.closeBoard(board));
  cellSeat(board, { lane: 'coordinator', path: '/coordinator' });
  const say = [];
  const state = { board, config: { lanes: { api: { owns: ['api/'] } }, affectedTests: 'node --test' }, say: line => say.push(line),
    batch: { id: 'b1', base: 'a'.repeat(40), tip: 'b'.repeat(40), root: '/nowhere', items: [] },
    write: async (operation, args) => store[operation](board, ...args) };
  return { board, state, say };
}

const pending = board => store.listItems(board, { all: true }).filter(item => item.item_title.startsWith('Main red:'));

test('landing.main-red-dedupe.the-same-known-main-red-filed: clause 1: the same known-main red filed twice leaves one open item that gains a fact [B3,C7,H16,V4]', async t => {
  const { board, state, say } = fixture(t);
  await fileKnownMainReds(state, [{ file: FILE, name: 'case one' }]);
  assert.deepEqual(say, []);
  state.batch = { ...state.batch, id: 'b2' };
  const again = await fileKnownMainReds(state, [{ file: FILE, name: 'case one' }]);
  assert.equal(pending(board).length, 1);
  assert.equal(again[0].item, pending(board)[0].item_id);
  const facts = store.itemThread(board, pending(board)[0].item_id).filter(entry => entry.type === 'fact');
  assert.equal(facts.length, 1, 'the second filing is a fact on the open repair');
  assert.match(facts[0].text, /case one/u);
});

test('landing.main-red-dedupe.an-audit-item-and-a-post: clause 1: an audit item and a post-land item for the same case are one cause [B3,C7,H16,V4]', t => {
  const audit = auditFailureItem({ failures: [{ file: FILE, name: 'case one' }], landings: [], lane: 'api' });
  const items = [{ item_id: 7, item_status: 'open', item_title: audit.title, item_brief: audit.brief, item_criterion: audit.criterion }];
  const { owned, fresh } = splitMainReds(items, [{ file: FILE, name: 'case one' }]);
  assert.deepEqual([...owned.keys()], [7]);
  assert.equal(fresh.length, 0);
});

test('landing.main-red-dedupe.the-post-land-suite-files-a: clause 2: the post-land suite files a red again as a fact, not a second item [B3,C7,H16,V4]', async t => {
  const { board, state } = fixture(t);
  const { root } = privateFixtureFiles('main-red-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let result = { green: true, failures: [] };
  const ports = { enabled: () => true, storePath: () => join(root, 'last.json'), runSuite: async () => result,
    readItems: b => store.listItems(b, { all: true }), laneOf: () => 'api', unownedMainReds: (known) => known.failures.map(row => ({ file: row.file, names: [row.name] })) };
  const red = { green: false, failures: [{ file: FILE, name: 'case one', signature: 'x' }] };
  await postLandSuite(state, ports);
  for (let round = 0; round < 2; round++) {
    result = red;
    await postLandSuite(state, ports);
    result = { green: true, failures: [] };
    await postLandSuite(state, ports);
  }
  assert.equal(pending(board).length, 1, 'two reds of one case file one item');
});

test('landing.main-red-dedupe.a-different-file-or-case-still: clause 3: a different file or case still files its own item [B3,C7,H16,V4]', async t => {
  const { board, state } = fixture(t);
  await fileKnownMainReds(state, [{ file: FILE, name: 'case one' }]);
  const { owned, fresh } = splitMainReds(store.listItems(board, { all: true }), [{ file: FILE, name: 'case two' }, { file: 'api/other.test.js', name: 'case one' }]);
  assert.equal(owned.size, 0);
  assert.equal(fresh.length, 2);
});
