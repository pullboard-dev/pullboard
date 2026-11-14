/** pullboard relay recover reaches a second computer that was already linked and caught up before it (#7776) [B26,H16,H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  parkedBoard,
  shoutTexts,
} from '../../tests/fixtures/relay/parked.js';

test('clause 1: a computer linked and synced before the parked move reads it on its next sync after relay recover [B26,H16,H17]', { timeout: 280_000 }, async (t) => {
  const { box, other, big } = await parkedBoard(t);
  const before = await other.cli('export');
  assert.equal(before.code, 0, before.failure);
  assert.ok(shoutTexts(before.document).includes('small after the big move'), 'the second computer is caught up with the relay head');
  assert.ok(!JSON.stringify(before.document).includes(big), 'it does not hold the parked move yet');
  const recovered = await box.cliLocal('relay', 'recover');
  assert.equal(recovered.code, 0, recovered.failure);
  const there = await other.cli('export');
  assert.equal(there.code, 0, there.failure);
  const linkOf = JSON.parse(readFileSync(join(other.root, '.git', 'pullboard', 'relay.json'), 'utf8'));
  assert.ok(JSON.stringify(there.document).includes(big), 'DEBUG ' + JSON.stringify({ epoch: linkOf.checkpointEpoch, sequence: linkOf.sequence, mine: JSON.parse(readFileSync(box.linkFile, 'utf8')).checkpointEpoch, status: (await other.cli('status')).document.relay }));
  assert.ok(shoutTexts(there.document).includes('small after the big move'), 'no history is lost');
  const again = await other.cli('export');
  assert.equal(again.code, 0, again.failure);
  const history = (exported) => exported.tables.event.map((row) => [row.event_kind, row.item_id]);
  assert.deepEqual(history(again.document), history((await box.cliLocal('export')).document), 'both computers hold the same history in the same order');
});
