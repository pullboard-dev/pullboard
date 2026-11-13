/** pullboard relay recover resolves a parked move in place under the same board (#6693) [B26,H16,H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  parkedBoard,
  shoutTexts,
} from '../../tests/fixtures/relay/parked.js';

test('clause 2: pullboard relay recover publishes a checkpoint under the same board id and a second computer reads every move [B26,H16,H17]', { timeout: 280_000 }, async (t) => {
  const { box, other, board, big } = await parkedBoard(t);
  const recovered = await box.cliLocal('relay', 'recover');
  assert.equal(recovered.code, 0, recovered.failure);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(link.board, board, 'the board id is unchanged: no rejoin');
  const there = await other.cli('export');
  assert.equal(there.code, 0, there.failure);
  const texts = shoutTexts(there.document);
  assert.ok(JSON.stringify(there.document).includes(big), 'the parked move\'s effect reaches the second computer');
  assert.ok(texts.includes('small after the big move'), 'no history is lost');
  const history = (exported) => exported.tables.event.map((row) => [row.event_kind, row.item_id]);
  assert.deepEqual(history((await box.cliLocal('export')).document), history(there.document), 'both computers hold the same history in the same order');
});

