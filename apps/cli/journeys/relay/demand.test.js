/** Relay is on by demand: nothing leaves the machine until the person signs in, and a person exclusion stays [H5,H17,B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

test('cli.journeys-relay-demand.a-fresh-machine-sends-no-relay: a fresh machine sends no relay traffic, says it is local, and shares sealed after sign-in [H5,H17]', async (t) => {
  const box = await relayClientFixture(t);
  const status = await box.cliLocal('status');
  assert.equal(status.code, 0);
  assert.equal(box.calls.length, 0, 'before any sign-in no request reaches the relay');
  assert.equal(status.document.relay?.excluded, undefined);
  await box.link();
  assert.ok(box.calls.length > 0, 'the sign-in turns relay on and the board then syncs');
  assert.ok(box.calls.some(call => call.method !== 'GET' && /\/boards\//u.test(call.path)), 'the board is then sent to the relay, which only ever receives sealed pages');
});

test('cli.journeys-relay-demand.a-board-the-person-turned-off: a board the person turned off stays excluded and sends nothing more [H5,B26]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cliLocal('relay', 'off')).code, 0);
  const sent = box.calls.length;
  const status = await box.cliLocal('status');
  assert.equal(status.document.relay.excluded, true);
  assert.equal(status.document.relay.exclusion.reason, 'person relay off');
  assert.equal(box.calls.length, sent, 'an excluded board makes no further relay request');
});
