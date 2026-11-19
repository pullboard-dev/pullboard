/** @pullboard-test-input packages/landing/src/io/pulled/fresh.js */
/** A pulled landing offer reopens a verified item whose reviewed file main has since changed, and leaves a fresh accept alone [B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutStaleVerdicts } from '../../../index.js';
import * as store from '../../../../store/index.js';
import { verifiedThenMainMoves } from '../../fixtures/stale-verdict.js';

test('landing.fresh.main-changing-a-reviewed-file-reopens: clause 2: main changing a reviewed file reopens the verified item to its lane and names the file [B3,C7]', async t => {
  const { board, repo, item, main } = verifiedThenMainMoves(t, 'web/x.js');
  assert.equal(store.getItem(board, item).item_status, 'verified');
  const said = [];
  const written = [];
  const write = async (operation, args) => { written.push(operation); return store[operation](board, args[0], args[1]); };
  const all = await withoutStaleVerdicts(board, repo.root, main, store.listItems(board, { all: true }), { candidate: () => true, write, say: line => said.push(line) });
  assert.deepEqual(written, ['reopen']);
  assert.equal(store.getItem(board, item).item_status, 'open', 'the accept is withdrawn and the item is back in its lane');
  assert.equal(all.find(row => row.item_id === item).item_status, 'open', 'the offer no longer takes it');
  assert.match(said.join('\n'), new RegExp(`STALE_VERDICT #${item} reopened to its lane: web/x.js changed on main in ${main.slice(0, 12)}`, 'u'));
});

test('landing.fresh.main-changing-only-an-unreviewed-file: clause 2: main changing only an unreviewed file leaves the verified item landable and writes nothing [B3,C7]', async t => {
  const { board, repo, item, main } = verifiedThenMainMoves(t, 'web/y.js');
  const written = [];
  const all = await withoutStaleVerdicts(board, repo.root, main, store.listItems(board, { all: true }), { candidate: () => true, write: async operation => { written.push(operation); }, say: () => {} });
  assert.deepEqual(written, []);
  assert.equal(all.find(row => row.item_id === item).item_status, 'verified');
});
