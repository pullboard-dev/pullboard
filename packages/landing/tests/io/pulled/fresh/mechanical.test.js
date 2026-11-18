/** @pullboard-test-input packages/landing/src/io/pulled/fresh.js */
/** A pulled landing offer passes a mechanical-conflict port to verdict freshness, so a conflict the port reports resolved keeps the accept landable [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutStaleVerdicts } from '../../../../index.js';
import * as store from '../../../../../store/index.js';
import { verifiedThenMainMoves } from '../../../fixtures/stale-verdict.js';

/** Offer the verified item after main changes the very file it reviewed (a conflict), under the given ports. */
async function offer(t, ports) {
  const { board, repo, item, main } = verifiedThenMainMoves(t, 'web/x.js');
  const written = [];
  const said = [];
  const all = await withoutStaleVerdicts(board, repo.root, main, store.listItems(board, { all: true }), { candidate: () => true, say: line => said.push(line), ...ports,
    write: async (operation, args) => { written.push(operation); return store[operation](board, args[0], args[1]); } });
  return { all, item, written, said, main };
}

test('landing.fresh-mechanical.empty-residual-keeps-landable: clause 1: a port reporting no residual conflict leaves the accepted item verified, landable and unwritten [C7]', async t => {
  const { all, item, written } = await offer(t, { residualConflicts: () => [] });
  assert.deepEqual(written, []);
  assert.equal(all.find(row => row.item_id === item).item_status, 'verified');
});

test('landing.fresh-mechanical.residual-file-reopens: clause 1: a port reporting a residual file, or no port, still reopens the item to its lane naming the file [C7]', async t => {
  for (const ports of [{ residualConflicts: () => ['web/x.js'] }, {}]) {
    const { all, item, written, said, main } = await offer(t, ports);
    assert.deepEqual(written, ['reopen']);
    assert.equal(all.find(row => row.item_id === item).item_status, 'open');
    assert.match(said.join('\n'), new RegExp(`STALE_VERDICT #${item} reopened to its lane: web/x\\.js changed on main in ${main.slice(0, 12)}`, 'u'));
  }
});
