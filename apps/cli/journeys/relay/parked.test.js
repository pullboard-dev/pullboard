/** A move the relay refuses for good is parked and later moves are sent and acknowledged (#6693) [B26,H16,H17]. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parkedBoard,
  shoutTexts,
} from '../../tests/fixtures/relay/parked.js';

test('clause 1: a move the relay permanently refuses is parked and later moves are sent and acknowledged [B26,H16,H17]', { timeout: 280_000 }, async (t) => {
  const { box, other, before, big, synced } = await parkedBoard(t);
  const outbox = synced.document.relay.outbox;
  assert.equal(outbox.length, 1, 'only the refused move stays in the outbox');
  assert.equal(outbox[0].operation, 'appendFact');
  assert.ok(outbox[0].parked?.code, 'the outbox entry says the relay refused it for good');
  assert.ok(synced.document.relay.sequence > before, 'the small move behind the refused one was sent and acknowledged');
  const there = await other.cli('export');
  const texts = shoutTexts(there.document);
  assert.ok(texts.includes('small after the big move'), 'the second computer reads the move that flowed');
  assert.ok(!JSON.stringify(there.document).includes(big.slice(0, 200)), 'the refused move did not reach the relay');
  const again = await box.cliLocal('status');
  assert.equal(again.document.relay.outbox.length, 1, 'a later sync leaves the parked move parked, not retried in a loop');
});

