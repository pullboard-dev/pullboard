/** Next contention setting: queue.contention exists, off by default, and leaves the order alone [C7,#8526,#1389]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { SETTING_DESCRIPTIONS } from '../../../../packages/config/index.js';
import { boardFixture } from '../../tests/fixtures/next/order.js';
import { readyItem } from '../../tests/fixtures/next/order.js';

test('clause 1: the settings registry holds queue.contention, a described on/off setting that defaults to off [C7,#8526]', () => {
  assert.equal(configFromSource('{}').queue?.contention, undefined, 'a project that never sets it has it off');
  assert.equal(configFromSource('{"queue":{"contention":true}}').queue.contention, true, 'a project may turn it on');
  assert.equal(SETTING_DESCRIPTIONS['queue.contention'].unit, 'on/off', 'it is a described on/off setting');
  assert.throws(() => configFromSource('{"queue":{"contention":"yes"}}'), /queue\.contention/u, 'only a boolean is accepted');
});

test('clause 2: next orders ready items exactly as before when queue.contention is off [C7,#8526]', t => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const first = readyItem(board, 'Older ready item');
  readyItem(board, 'Newer ready item');
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, first, 'with the setting unset the older item is offered first, as before');
});
