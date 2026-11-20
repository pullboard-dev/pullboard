/** With items.barRulesAtAdd on, add refuses a lane item that names no spec row, so a filer supplies it and builders never draft one [C7,#11778]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../../../packages/config/index.js';
import * as store from '../../../../../../packages/store/index.js';
import { requireSpecRow } from '../../../../src/io/item/bar.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

/** Write the fixture machine's settings with items.barRulesAtAdd as given, keeping the fixture's own quiet fields. */
function barRules(on) {
  writeFileSync(machineSettingsFile(), JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, items: { barRulesAtAdd: on } }));
}

/** The refusal code a CLI run printed, or null when it exited 0. */
const refusal = result => (result.code === 0 ? null : result.document?.error?.code ?? `exit ${result.code}: ${result.out}${result.err}`);

const add = (box, title, ...args) => cli(box, box.seats.actor.path, ['add', 'web', title, '--criterion', `1. ${title} [test]`, ...args]);

test('cli.io-item-bar-spec-row.refused-without-row: clause 1: with the setting on, a lane item with no spec row is refused SPEC_ROW_NEEDED naming spec draft and the same add with --specs [C7,#11778]', () => {
  assert.throws(() => requireSpecRow({ lane: 'web', title: 'The page renders', specIds: [] }, true), error => {
    assert.equal(error.code, 'SPEC_ROW_NEEDED');
    assert.match(error.next, /pullboard spec draft "The page renders"/u);
    assert.match(error.next, /--specs <id>/u);
    return true;
  });
});

test('cli.io-item-bar-spec-row.allowed: clause 2: an add naming a row, a coordinator-lane item, and any add with the setting off are filed as today [C7,#11778]', async t => {
  requireSpecRow({ lane: 'web', title: 'T', specIds: ['G1'] }, true);
  requireSpecRow({ lane: 'coordinator', title: 'T', specIds: [] }, true);
  requireSpecRow({ lane: 'web', title: 'T', specIds: [] }, false);
  const box = await fixture(t);
  barRules(true);
  const named = await add(box, 'Checkout totals add up', '--specs', 'G1');
  assert.equal(refusal(named), null, named.out + named.err);
  barRules(false);
  const off = await add(box, 'Login link expires after a day');
  assert.equal(refusal(off), null, off.out + off.err);
});

test('cli.io-item-bar-spec-row.real-add: clause 3: the real add command on a fixture board refuses a lane add without --specs when the setting is on and files nothing [C7,#11778]', async t => {
  const box = await fixture(t);
  barRules(true);
  const before = store.listItems(box.board, { all: true }).length;
  const refused = await add(box, 'The page renders');
  assert.equal(refusal(refused), 'SPEC_ROW_NEEDED', refused.out + refused.err);
  assert.match(refused.document.error.next ?? refused.out, /spec draft/u);
  assert.equal(store.listItems(box.board, { all: true }).length, before, 'the refused add files no item');
});
