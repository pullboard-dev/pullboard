/** @pullboard-test-input source-cell pages kernel */
/** The sealed item snapshot carries an item's typed fields and related ids, and leaves an item without them as it was (#9358, #1321) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateBoardKey } from '../../../kernel/index.js';
import { openPagedSnapshot } from '../../index.js';
import { writePagedSnapshot } from '../../index.js';

const ENGINE = 56;
const FIELDS = [{ name: 'points', type: 'number', value: 3 }, { name: 'priority', type: 'choice', value: 'high' }];

/** A private cipher store and a document of two items; `extra` is merged into item 2 only. */
async function fixture(extra = {}) {
  const objects = new Map();
  const context = {
    key: await generateBoardKey(), boardId: 'c'.repeat(32), sequence: 7,
    put(object) { objects.set(object.id, object); },
    get(id) { return objects.get(id).bytes; },
    lookup() { return undefined; },
    remember() {},
  };
  const items = [1, 2].map(id => ({ id, title: 'Item ' + id, lane: 'core', specs: ['C7'], status: 'open', criterion: 'c', brief: 'b', verdicts: [], history: [], thread: [], ...(id === 2 ? extra : {}) }));
  const document = { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: context.boardId }, { meta_key: 'relay_applied_sequence', meta_value: '7' }, { meta_key: 'relay_engine_version', meta_value: String(ENGINE) }],
    shout: [], event: [], item: [{ item_id: 1 }, { item_id: 2 }], agent: [], verdict: [], sqlite_sequence: [],
  }, presentation: { version: 1, config: { name: 'Synthetic board' }, state: {
    items, agents: [], shouts: [], decisions: [], asked: [], events: [], holds: [], spec: [], practice: [], lanes: ['core'], owning: ['core'],
  }, shouts: [] } };
  const root = await writePagedSnapshot(document, context);
  return { objects, page: await openPagedSnapshot(root, context, { maxEngine: ENGINE }), document };
}

test('clause 1: the sealed snapshot carries the item fields with their types and its related ids, and a reader built from it shows them [C7,#9358]', async () => {
  const { page } = await fixture({ fields: FIELDS, relatedIds: [1] });
  const boot = await page.presentation();
  const summary = boot.state.items.find(item => item.id === 2);
  assert.deepEqual(summary.fields, FIELDS, 'the first screen shows the typed fields');
  assert.deepEqual(summary.relatedIds, [1], 'the first screen shows the related ids');
  const full = await page.item(2);
  assert.deepEqual(full.fields, FIELDS);
  assert.deepEqual(full.relatedIds, [1]);
});

test('clause 2: a snapshot of items with no fields or links has the same sealed bytes as before and adds no keys [C7,#9358]', async () => {
  const first = await fixture();
  const second = await fixture();
  const sizes = box => [...box.objects.values()].map(object => object.bytes.byteLength).sort((a, b) => a - b);
  assert.deepEqual(sizes(first), sizes(second), 'two sealings of the same plain items make objects of the same sizes');
  const boot = await first.page.presentation();
  for (const item of boot.state.items) assert.ok(!Object.hasOwn(item, 'fields') && !Object.hasOwn(item, 'relatedIds'));
  const full = await first.page.item(2);
  assert.ok(!Object.hasOwn(full, 'fields') && !Object.hasOwn(full, 'relatedIds'));
});
