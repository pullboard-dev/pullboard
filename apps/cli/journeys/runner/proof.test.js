/** A green pulled gate records the item's native proof-run receipts, as today's submit does, and show lists them [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { proofReceipts } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

test('clause 2: a green pulled-gate receipt records the check and proof runs as the item\'s proof-run receipts, and show lists them [P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const { commit } = submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const seat = getItem(board, id).item_owner;
  assert.equal((await serveOnce(box, url, 'r-proof')).code, 0);
  assert.equal(getItem(board, id).item_status, 'submitted');

  const receipts = proofReceipts(board, id);
  assert.deepEqual(receipts.map(row => [row.kind, row.submitPhase, row.item, row.commit, row.seat, row.runner, row.exitCode]),
    [['submit', 'criterion', id, commit, seat, 'r-proof', 0], ['submit', 'proof', id, commit, seat, 'r-proof', 0]], JSON.stringify(receipts));
  assert.ok(receipts.every(row => row.frozenDigest === getItem(board, id).item_frozen_digest && row.environment?.node === process.versions.node));

  const shown = box.run(box.web, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err);
  assert.deepEqual(JSON.parse(shown.out).proofReceipts.map(row => row.id), receipts.map(row => row.id), 'show --json carries them');
  const text = box.run(box.web, 'show', String(id));
  for (const row of receipts) assert.match(text.out, new RegExp(`receipt ${row.id}: submit, item #${id}`, 'u'), 'show lists each receipt');
  assert.match(text.out, /runner r-proof; seat /u);
});
