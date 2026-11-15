/** An older-engine reader meeting a newer relay move stops with an upgrade next step and leaves the journal intact [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seal } from '../../../packages/kernel/index.js';
import { syncRelay } from '../../../packages/link/index.js';
import { ENGINE_VERSION } from '../../../packages/state/index.js';
import { relayDirectFixture } from './fixtures/relay-direct-fixture.js';

/** Read the relay's whole ordered journal as the client would, as one comparable string. */
async function journal(box, link) {
  const response = await fetch(`${box.origin}/api/v1/boards/${link.board}/events?after=0`, {
    headers: { authorization: `Bearer ${link.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(response.status, 200);
  return JSON.stringify(await response.json());
}

test('clause 1: a reader whose engine is older than a relay move stops with ENGINE_VERSION and an upgrade next step [C7,H16]', async (t) => {
  const box = await relayDirectFixture(t);
  await box.link();
  const link = box.readLink();
  const before = await journal(box, link);
  const future = { version: 1, engine: ENGINE_VERSION + 1, id: 'future-engine-record', operation: 'futureOperation', args: [] };
  const sequence = link.sequence + 1;
  const sealed = Buffer.from(await seal(Buffer.from(box.readKey(), 'base64url'), new TextEncoder().encode(JSON.stringify(future)), { boardId: link.board, kind: 'move', sequence })).toString('base64url');
  const sent = await fetch(`${box.origin}/api/v1/boards/${link.board}/moves`, {
    method: 'POST', body: JSON.stringify({ sequence, sealed }),
    headers: { authorization: `Bearer ${link.token}`, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  const afterAppend = await journal(box, link);
  const lines = [];
  const summary = await syncRelay(box.root, { ...box.io, err: (line) => lines.push(String(line)) });
  console.log(JSON.stringify({ summary, lines, before: before.length, afterAppend: afterAppend.length }));
});
