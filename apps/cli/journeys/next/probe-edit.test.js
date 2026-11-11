import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

test('probe edit wait [V2,N2]', async t => {
  const box = await fixture(t);
  const id = box.add('An open corrected bar');
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  const t0 = Date.now();
  console.log('PROBE start');
  console.log('PROBE start');
  const changed = await cli(box, box.root, ['edit', String(id), '--criterion', 'c', '--check', 'true && true', '--reason', 'r', '--wait']);
  console.log('PROBE done', Date.now() - t0, changed.code, JSON.stringify(store.getItem(box.board, id).item_check_baseline));
  assert.equal(changed.code, 0, changed.out + changed.err);
});
