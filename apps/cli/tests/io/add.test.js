/** @pullboard-test-input apps/cli/src/io/add.js apps/cli/tests/fixtures/next/take.js */
/** With laneMode off, pullboard add and edit accept a brief naming files outside the item's lane folders; with it on, add still refuses BRIEF_LANE [C7,#10843]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { cli } from '../fixtures/next/take.js';
import { fixture } from '../fixtures/next/take.js';

/** A web-lane brief whose Files section names a file in the docs lane's folder. */
const FOREIGN = 'Files:\n- docs/x.js\nTest: the docs page renders\n';

/** File one web-lane item from the main checkout through the real CLI main(), as a customer's coordinator does. */
function add(box, brief) {
  return cli(box, box.root, ['add', 'web', 'Docs page', '--specs', 'G1', '--route', 'mid', '--criterion', 'the docs page renders', '--check', 'false', '--brief', brief]);
}

test('cli.io-add.lanes-off-foreign-brief: clause 1: with laneMode off, pullboard add files a web-lane item whose brief names docs/x.js [C7,#10843]', async t => {
  const box = await fixture(t, { projectConfig: { laneMode: 'off' } });
  const added = await add(box, FOREIGN);
  assert.equal(added.code, 0, added.out + added.err);
  const id = added.document.item.item_id;
  assert.match(store.getItem(box.board, id).item_brief, /docs\/x\.js/u);
});

test('cli.io-add.lanes-on-refused: clause 2: with laneMode on, the same add is refused BRIEF_LANE naming docs/x.js [C7,#10843]', async t => {
  const box = await fixture(t);
  const added = await add(box, FOREIGN);
  assert.equal(added.code, 1, added.out + added.err);
  const { error } = added.document;
  assert.equal(error.code, 'BRIEF_LANE', added.out);
  assert.match(error.message, /docs\/x\.js/u);
});

test('cli.io-add.lanes-off-edit-brief: clause 3: with laneMode off, pullboard edit --brief accepts a brief naming docs/x.js on a web-lane item [C7,#10843]', async t => {
  const box = await fixture(t, { projectConfig: { laneMode: 'off' } });
  const added = await add(box, 'Files:\n- web/x.js\nTest: the web page renders\n');
  assert.equal(added.code, 0, added.out + added.err);
  const id = added.document.item.item_id;
  const edited = await cli(box, box.root, ['edit', String(id), '--brief', FOREIGN]);
  assert.equal(edited.code, 0, edited.out + edited.err);
  assert.match(store.getItem(box.board, id).item_brief, /docs\/x\.js/u);
});
