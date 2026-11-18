import assert from 'node:assert/strict';
import test from 'node:test';
import { relayDirectFixture } from './fixtures/relay-direct-fixture.js';

test('relay.relay-on-direct.a-board-links-to-the-relay: a board links to the relay by calling relayOn directly, with no CLI process [H1,H18]', async (t) => {
  const box = await relayDirectFixture(t);
  await box.link();
  const link = box.readLink();
  assert.equal(link.url, box.origin, 'the saved link names the loopback relay');
  assert.match(link.board, /^[0-9a-f]{32}$/u, 'the link names the board');
  assert.match(link.token ?? '', /^pm_/u, 'the relay issued this machine its credential');
  assert.equal(link.linkPending, undefined, 'the link finished');
  assert.ok(box.readKey().length > 0, 'the device key is saved');
  assert.ok(box.server.calls.some(call => call.method === 'POST' && call.path === '/auth/boards/link'), 'the relay received the board link');
});
