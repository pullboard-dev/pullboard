/** A move over the relay's request limit is refused with its size and the limit, as a snapshot upload is (#1196, #6696) [H5,H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

/** A body over every relay move limit this repo has had: the local 100 KB and the hosted relay's 10 MB (#6707). */
const OVER_EVERY_LIMIT = 11_000_000;

test('clause 1: a move over the relay body limit gets a structured refusal carrying its bytes and the limit [H5,H17]', { timeout: 180_000 }, async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const body = JSON.stringify({ sequence: 2, sealed: 'A'.repeat(OVER_EVERY_LIMIT) });
  const measured = Buffer.byteLength(body);
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/moves', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body,
  });
  const document = await response.json();
  assert.equal(response.status, 400, 'the relay refuses the over-limit move');
  assert.equal(document.error.code, 'MOVE_TOO_LARGE', 'the refusal is the structured move refusal, not a plain BAD_REQUEST');
  const { limit } = document.error.moveLimit;
  assert.ok(limit >= 100_000 && limit < measured, 'the refusal states a relay limit the move is over');
  assert.deepEqual(document.error.moveLimit, { moveBytes: measured, limit }, 'the refusal states the move\'s measured bytes and the limit');
  assert.match(document.error.message, new RegExp(`${measured} bytes.*${limit}`, 'u'), 'the message names both numbers');
});
