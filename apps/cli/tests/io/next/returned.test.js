/** @pullboard-test-input apps/cli/src/io/next/returned.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { returnedEchoLines } from '../../../src/io/next/returned.js';

const row = (id, status, verdict, builder) => ({ item_id: id, item_title: 'T' + id, item_status: status, item_verdict: verdict, item_built_by: builder });
const verdicts = { 1: { verdict_reason: 'BAR', verdict_note: 'no case\nproves it' }, 4: { verdict_reason: 'FAILED', verdict_note: 'red' } };

test('cli.io-next-returned.lines-for-open-rejects: one echo line per open REJECT item this seat built, in item order, none for other seats, claimed or submitted items [C7,#2220]', () => {
  const items = [row(1, 'open', 'REJECT', 'me'), row(2, 'open', 'REJECT', 'other'), row(3, 'claimed', 'REJECT', 'me'), row(4, 'open', 'REJECT', 'me'), row(5, 'submitted', 'REJECT', 'me')];
  assert.deepEqual(returnedEchoLines(items, id => verdicts[id], 'me'), ['rejected #1 T1: BAR: no case proves it', 'rejected #4 T4: FAILED: red']);
});

test('cli.io-next-returned.reads-only-returned: no returned item gives an empty array with no verdictFor call, and one returned item among others calls it once [C7,#2220]', () => {
  const calls = [];
  const verdictFor = id => { calls.push(id); return verdicts[id]; };
  assert.deepEqual(returnedEchoLines([row(2, 'open', 'REJECT', 'other'), row(3, 'open', null, 'me')], verdictFor, 'me'), []);
  assert.deepEqual(calls, []);
  assert.equal(returnedEchoLines([row(2, 'open', null, 'me'), row(1, 'open', 'REJECT', 'me'), row(6, 'claimed', 'REJECT', 'me')], verdictFor, 'me').length, 1);
  assert.deepEqual(calls, [1]);
});
