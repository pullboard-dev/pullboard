/** The hosted relay takes a sealed move up to 10 MB while the local API keeps its 100 KB body limit (GitHub #14, #6707) [H5,H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  decodeBoardKey,
  seal,
} from '../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

/** Post one sealed move of about `bytes` base64 characters to the linked board's given sequence. */
async function postMove(box, sequence, bytes) {
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const plain = new TextEncoder().encode(JSON.stringify({ filler: 'x'.repeat(Math.floor(bytes * 3 / 4)) }));
  const sealed = Buffer.from(await seal(key, plain, { boardId: link.board, kind: 'move', sequence })).toString('base64url');
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/moves', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + link.token, 'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION) },
    body: JSON.stringify({ sequence, sealed }),
  });
  return { status: response.status, body: await response.json(), size: sealed.length };
}

test('clause 1: the relay accepts sealed moves from 180 KB to 9.5 MB and refuses one over 10 MB [H5,H17]', { timeout: 280_000 }, async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const first = (await box.cliLocal('status')).document.relay.sequence + 1;
  const big = await postMove(box, first, 180_000);
  assert.ok(big.size >= 180_000, 'the sealed move is about 180 KB');
  assert.equal(big.status, 200, 'a move over the local API 100 KB default is accepted by the relay');
  const large = await postMove(box, first + 1, 9_500_000);
  assert.ok(large.size >= 9_500_000, 'the sealed move is about 9.5 MB');
  assert.equal(large.status, 200, 'a sealed move of about 9.5 MB is accepted');
  const huge = await postMove(box, first + 2, 11_000_000);
  assert.equal(huge.status, 400);
  assert.match(huge.body.error.message, /10000000 bytes/);
});
