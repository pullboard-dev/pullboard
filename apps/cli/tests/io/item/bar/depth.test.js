/** add and edit refuse an --after chain deeper than 3 open items, behind items.barRulesAtAdd [C7,#12477]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../../../packages/config/index.js';
import * as store from '../../../../../../packages/store/index.js';
import { chainDepthOf } from '../../../../src/io/item/bar.js';
import { requireChainDepth } from '../../../../src/io/item/bar.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

/** Write the fixture machine's settings with items.barRulesAtAdd on, keeping the fixture's own quiet fields. */
function barRulesOn() {
  writeFileSync(machineSettingsFile(), JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, items: { barRulesAtAdd: true } }));
}

/** The refusal code a CLI run printed, or null when it exited 0. */
const refusal = result => (result.code === 0 ? null : result.document?.error?.code ?? `exit ${result.code}: ${result.out}${result.err}`);

const row = (id, after, status = 'open', extra = {}) => ({ item_id: id, item_status: status, item_after: after, ...extra });
const add = (box, title, ...args) => cli(box, box.seats.actor.path, ['add', 'web', title, '--specs', 'G1', '--criterion', `1. ${title} [test]`, ...args]);

test('cli.io-item-bar-depth.refuse-over-3: clause 1: requireChainDepth refuses CHAIN_TOO_DEEP when the longest --after chain through open items, itself counted, is deeper than 3, names the deepest chain and says to split interface-first, and accepts depth 3 [C7,#12477]', () => {
  const depthOf = chainDepthOf([row(1, ''), row(2, '1'), row(3, '2'), row(4, '3'), row(5, '1')]);
  assert.deepEqual(depthOf('4'), [4, 3, 2, 1]);
  requireChainDepth(['2'], depthOf);
  requireChainDepth([5], depthOf);
  requireChainDepth([], depthOf);
  assert.throws(() => requireChainDepth(['3'], depthOf), error => error.code === 'CHAIN_TOO_DEEP' && /#3 -> #2 -> #1/u.test(error.message));
  assert.throws(() => requireChainDepth(['4', '5'], depthOf), error => {
    assert.equal(error.code, 'CHAIN_TOO_DEEP');
    assert.match(error.message, /#4 -> #3 -> #2 -> #1/u);
    assert.match(error.next, /split interface-first/u);
    return true;
  });
  assert.throws(() => requireChainDepth('#3', depthOf), error => error.code === 'CHAIN_TOO_DEEP');
});

test('cli.io-item-bar-depth.closed-items-and-cycles: clause 1: a merged, closed or unknown item is no link of the chain, a cycle ends where it repeats, and the edited item never counts as its own link [C7,#12477]', () => {
  const depthOf = chainDepthOf([row(1, ''), row(2, '1', 'verified', { item_merged_commit: 'abc' }), row(3, '2'), row(4, '3'), row(5, '4', 'claimed'), row(8, '9'), row(9, '8')]);
  assert.deepEqual(depthOf('2'), []);
  assert.deepEqual(depthOf('5'), [5, 4, 3]);
  assert.deepEqual(depthOf('7'), []);
  assert.deepEqual(depthOf('8'), [8, 9]);
  requireChainDepth(['4'], depthOf);
  assert.throws(() => requireChainDepth(['5'], depthOf), error => error.code === 'CHAIN_TOO_DEEP');
  requireChainDepth(['5'], depthOf, 5);
});

test('cli.io-item-bar-depth.add-refuses-deep: clause 2: the real add command refuses CHAIN_TOO_DEEP behind the setting and files nothing, accepts depth 3, and the real edit command refuses the same chain [C7,#12477]', async t => {
  const box = await fixture(t);
  barRulesOn();
  const ids = [];
  for (const title of ['Render the invoice totals', 'Cache the shipping quotes', 'Expire stale login links']) {
    const filed = await add(box, title, ...(ids.length ? ['--after', String(ids.at(-1))] : []));
    assert.equal(refusal(filed), null, filed.out + filed.err);
    ids.push(Math.max(...store.listItems(box.board, { all: true }).map(item => item.item_id)));
  }
  const before = store.listItems(box.board, { all: true }).length;
  const refused = await add(box, 'Archive old audit exports', '--after', String(ids.at(-1)));
  assert.equal(refusal(refused), 'CHAIN_TOO_DEEP', refused.out + refused.err);
  assert.equal(store.listItems(box.board, { all: true }).length, before, 'the refused add files no item');
  const loose = await add(box, 'Tint the empty-state banner');
  assert.equal(refusal(loose), null, loose.out + loose.err);
  const looseId = Math.max(...store.listItems(box.board, { all: true }).map(item => item.item_id));
  const edited = await cli(box, box.seats.actor.path, ['edit', String(looseId), '--after', String(ids.at(-1))]);
  assert.equal(refusal(edited), 'CHAIN_TOO_DEEP', edited.out + edited.err);
});
