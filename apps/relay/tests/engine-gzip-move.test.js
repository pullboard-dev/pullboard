/** Browser relay readers accept authenticated gzip moves and legacy JSON while retaining the move refusal for malformed data [H16,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { decodeSealedMove } from '../src/logic/browser/move.js';

test('relay.engine-gzip-move.browser-reader-accepts-gzip-and-legacy: gzip and legacy JSON decode to the same relay move [H16,H17]', async () => {
  const move = { version: 1, engine: 1, id: 'browser-move-7', event: { event_id: 7 }, receipt: { outcome: { item_id: 19 } } };
  const plain = Buffer.from(JSON.stringify(move));
  assert.deepEqual(await decodeSealedMove(new Uint8Array(gzipSync(plain))), move);
  assert.deepEqual(await decodeSealedMove(new Uint8Array(plain)), move);
});

test('relay.engine-gzip-move.browser-reader-refuses-malformed-gzip: malformed move bytes use the existing RELAY_MOVE refusal [H16,H17]', async () => {
  await assert.rejects(decodeSealedMove(new Uint8Array(gzipSync(Buffer.from('{')))), { code: 'RELAY_MOVE' });
});
