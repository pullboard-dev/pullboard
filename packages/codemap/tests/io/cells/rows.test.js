/** @pullboard-test-input packages/codemap/index.js packages/codemap/src/io/cells/move/rows.js packages/kernel/index.js */
/** A cited spec row whose text changed without a rewrite edit refuses, naming the coordinator [B4,R2,#5704]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireRewrittenRows } from '../../../index.js';

const frozen = text => JSON.stringify({ criterion: 'x', rows: [{ id: 'C7', text }] });
const item = (id, status, text) => ({ item_id: id, item_status: status, item_frozen: frozen(text) });
const LIVE = [{ id: 'C7', text: 'CI runs the gate on every push, Node 22.13 and 24.' }];

test('clause 1: a cited spec row whose text changed without a recorded rewrite edit refuses, naming the coordinator as the next step [B4,R2]', () => {
  assert.throws(() => requireRewrittenRows([item(7, 'claimed', 'CI runs the gate on every push.')], LIVE, { enabled: true }),
    error => error.code === 'ROW_REWRITE_MISSING' && /#7 cites C7/u.test(error.message) && /ask the coordinator to rewrite its bar: pullboard edit 7 /u.test(error.next));
});

test('clause 1: a row that still reads as frozen, a closed item and the setting off all pass [B4,R2]', () => {
  const same = item(1, 'open', LIVE[0].text);
  const old = 'CI runs the gate on every push.';
  assert.doesNotThrow(() => requireRewrittenRows([same, item(2, 'landed', old)], LIVE, { enabled: true }));
  assert.doesNotThrow(() => requireRewrittenRows([item(3, 'open', old)], LIVE), 'off by default');
});
