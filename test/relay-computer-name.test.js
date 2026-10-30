/** Person-given computer names remain display data, never coordinator authority [E19,H16]. */
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { relayClientFixture } from './relay-client-fixture.js';
import { relayWorkBudgetMs } from './relay-budget.js';
import { computerLabel } from '../src/coordinator-hold.js';
import { computerName } from '../src/computer-name.js';
import { requireCoordinatorHold } from '../src/coordinator-hold.js';
import { coordinatorHolder } from '../src/coordinator-hold.js';
import { COMPUTER_NAME_ENGINE } from '../src/computer-name-engine.js';
import { closeBoard } from '../src/board.js';
import { openBoard } from '../src/native-board.js';
import { readFileSync } from 'node:fs';

test('linked computers use person-given names in coordinator holds and devices [E19,H16]', { timeout: relayWorkBudgetMs(12) }, async t => { // budget: real two-device CLI sign-in, pairing, takeover and cleanup; no speed target.
  const box = await relayClientFixture(t);
  await box.link('Writing desk');
  const pairing = await box.cli('relay', 'pair');
  const other = await box.otherDeviceJoin(pairing.document.code, 'Travel laptop');
  assert.equal((await box.cli('add', box.lane, 'First named coordinator')).code, 0);
  const denied = await other.cli('add', box.lane, 'Other coordinator is refused');
  assert.equal(denied.document?.error?.code, 'COORDINATOR_HELD');
  assert.match(denied.document.error.message, /Writing desk/u);
  const taken = await other.cli('takeover');
  assert.equal(taken.code, 0);
  assert.equal(taken.document.coordinator, 'Travel laptop');
  assert.equal(taken.document.previous, 'Writing desk');
  const first = await box.cli('add', box.lane, 'Former coordinator is refused');
  assert.equal(first.document?.error?.code, 'COORDINATOR_HELD');
  assert.match(first.document.error.message, /Travel laptop/u);
  for (const [device, expected] of [[box, 'Travel laptop'], [other, 'Writing desk']]) {
    const roster = await device.cli('relay', 'devices');
    assert.equal(roster.code, 0);
    assert.ok(JSON.stringify(roster.document).includes(expected), 'device roster retains the explicit name');
    for (const privateText of [hostname(), box.root, other.root]) {
      assert.equal(JSON.stringify(roster.document).includes(privateText), false, 'roster does not disclose host or path');
      assert.equal(first.document.error.message.includes(privateText), false, 'refusal does not disclose host or path');
    }
  }
});

test('linked computers without names use the machine tail in real refusals and devices [E19]', { timeout: relayWorkBudgetMs(12) }, async t => { // budget: real unnamed two-device pairing and refusal, not a speed target.
  const box = await relayClientFixture(t);
  await box.link();
  const pairing = await box.cli('relay', 'pair');
  const other = await box.otherDeviceJoin(pairing.document.code);
  assert.equal((await box.cli('add', box.lane, 'Unnamed coordinator')).code, 0);
  const refused = await other.cli('add', box.lane, 'Other unnamed coordinator');
  const machine = JSON.parse(readFileSync(box.linkFile, 'utf8')).machine;
  assert.equal(refused.document?.error?.code, 'COORDINATOR_HELD');
  assert.ok(refused.document.error.message.includes(`computer ${machine.slice(-8)}`));
  const roster = await box.cli('relay', 'devices');
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
