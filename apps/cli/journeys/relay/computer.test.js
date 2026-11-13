/** Person-given computer names remain display data, never coordinator authority [E19,H16]. */
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { relayWorkBudgetMs } from '../../tests/fixtures/relay/budget.js';
import { computerLabel } from '../../../../packages/seats/index.js';
import { computerName } from '../../../../packages/seats/index.js';
import { requireCoordinatorHold } from '../../../../packages/seats/index.js';
import { coordinatorHolder } from '../../../../packages/seats/index.js';
import { COMPUTER_NAME_ENGINE } from '../../../../packages/state/light.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { readFileSync } from 'node:fs';

/**
 * Add an item as a coordinator and read the refusal the relay reports for it. A linked board moves locally first and
 * settles later [H21], so the add returns at once and the sync-time refusal appears in the device's status.
 */
async function refusedCoordinatorAdd(device, lane, title) {
  const since = new Date().toISOString();
  const added = await device.cli('add', lane, title);
  assert.equal(added.code, 0, 'a linked board applies the move locally at once, then settles it with the relay');
  const status = await device.cli('status');
  assert.equal(status.code, 0, status.failure);
  const refused = (status.document.relay.outboxRefusals ?? []).filter(entry => entry.queuedAt >= since).at(-1);
  assert.equal(refused?.code, 'COORDINATOR_HELD', JSON.stringify(status.document.relay.outboxRefusals ?? null));
  return refused;
}

test('linked computers use person-given names in coordinator holds and devices [E19,H16]', { timeout: relayWorkBudgetMs(12) }, async t => { // budget: real two-device CLI sign-in, pairing, takeover and cleanup; no speed target.
  const box = await relayClientFixture(t);
  await box.link('Writing desk');
  const pairing = await box.cliLocal('relay', 'pair');
  const other = await box.otherDeviceJoin(pairing.document.code, 'Travel laptop');
  assert.equal((await box.cliLocal('add', box.lane, 'First named coordinator')).code, 0);
  const denied = await refusedCoordinatorAdd(other, box.lane, 'Other coordinator is refused');
  assert.match(denied.message, /Writing desk/u);
  const taken = await other.cli('takeover');
  assert.equal(taken.code, 0);
  assert.equal(taken.document.coordinator, 'Travel laptop');
  assert.equal(taken.document.previous, 'Writing desk');
  const first = await refusedCoordinatorAdd(box, box.lane, 'Former coordinator is refused');
  assert.match(first.message, /Travel laptop/u);
  for (const [device, expected] of [[box, 'Travel laptop'], [other, 'Writing desk']]) {
    const roster = await device.cli('relay', 'devices');
    assert.equal(roster.code, 0);
    assert.ok(JSON.stringify(roster.document).includes(expected), 'device roster retains the explicit name');
    for (const privateText of [hostname(), box.root, other.root]) {
      assert.equal(JSON.stringify(roster.document).includes(privateText), false, 'roster does not disclose host or path');
      assert.equal(first.message.includes(privateText), false, 'refusal does not disclose host or path');
    }
  }
});

test('linked computers without names use the machine tail in real refusals and devices [E19]', { timeout: relayWorkBudgetMs(12) }, async t => { // budget: real unnamed two-device pairing and refusal, not a speed target.
  const box = await relayClientFixture(t);
  await box.link();
  const pairing = await box.cliLocal('relay', 'pair');
  const other = await box.otherDeviceJoin(pairing.document.code);
  assert.equal((await box.cliLocal('add', box.lane, 'Unnamed coordinator')).code, 0);
  const refused = await refusedCoordinatorAdd(other, box.lane, 'Other unnamed coordinator');
  const machine = JSON.parse(readFileSync(box.linkFile, 'utf8')).machine;
  assert.ok(refused.message.includes(`computer ${machine.slice(-8)}`));
  const roster = await box.cliLocal('relay', 'devices');
  assert.equal(roster.code, 0);
  assert.equal(roster.document.computers[0].name, null);
  assert.equal(JSON.stringify(roster.document).includes(hostname()), false);
});

test('unnamed computers retain ID-tail labels and invalid names are refused [E19,H16]', () => {
  assert.equal(computerLabel('machine-1234567890'), 'computer 34567890');
  assert.equal(computerLabel(undefined), 'another main checkout');
  assert.equal(computerName(undefined), undefined);
  assert.equal(computerName(' Writing desk '), 'Writing desk');
  for (const name of ['', '  ', '/Users/private/computer', 'C:\\private', 'two\nlines', 'a'.repeat(81), null]) {
    assert.throws(() => computerName(name), { code: 'BAD_COMPUTER_NAME' });
  }
});

test('older coordinator hold receipts retain their ID-tail display [E19,H16]', () => {
  const board = openBoard(':memory:');
  try {
    requireCoordinatorHold(board, { operation: 'addItem', engine: COMPUTER_NAME_ENGINE - 1,
      holder: 'machine-1234567890', holderName: 'Unrecognized future field' }, 'person-lineage', '2026-10-25T00:00:00Z');
    assert.equal(coordinatorHolder(board).label, 'computer 34567890');
  } finally { closeBoard(board); }
});
