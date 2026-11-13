/** A move over the relay's request limit is refused with its size and the limit, as a snapshot upload is (#1196, #6696) [H5,H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

/** The relay's request body limit for one move. */
const MOVE_BODY_LIMIT = 100_000;

test('clause 1: a move over the relay body limit gets a structured refusal carrying its bytes and the limit [H5,H17]', { timeout: 180_000 }, async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const body = JSON.stringify({ sequence: 2, sealed: 'A'.repeat(MOVE_BODY_LIMIT + 20_000) });
  const measured = Buffer.byteLength(body);
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/moves', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body,
  });
  const document = await response.json();
  assert.equal(response.status, 400, 'the relay refuses the over-limit move');
  assert.equal(document.error.code, 'MOVE_TOO_LARGE', 'the refusal is the structured move refusal, not a plain BAD_REQUEST');
  assert.deepEqual(document.error.moveLimit, { moveBytes: measured, limit: MOVE_BODY_LIMIT }, 'the refusal states the move\'s measured bytes and the limit');
  assert.match(document.error.message, new RegExp(`${measured} bytes.*${MOVE_BODY_LIMIT}`, 'u'), 'the message names both numbers');
});
