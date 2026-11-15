/** Submit refuses a [test] clause without a fail-before, pass-after receipt, and show prints it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clauseReceiptNotes } from '../../index.js';
import { clauseReceiptProblem } from '../../index.js';
import { clauseReceipts } from '../../index.js';

const FILE = 'packages/x/tests/a.test.js';
const BASE = 'b'.repeat(40), HEAD = 'c'.repeat(40);
const item = { item_id: 9, item_criterion: `1. The thing holds in ${FILE} [test]. 2. A command runs [command].`, item_brief: '' };
const row = (name, passed, extra = {}) => ({ file: FILE, name, passed, skipped: false, ...extra });
const proof = baseRows => ({ gateFiles: new Set([FILE]), baseRows, baseCommit: BASE });

test('clause 1: a [test] clause with no recorded run at base is refused [C7]', () => {
  const refused = clauseReceiptProblem(item, proof([]));
  assert.equal(typeof refused.next, 'string');
  assert.match(refused.message, /clause 1 names .*zero tests ran at base/u);
  assert.equal(clauseReceiptProblem(item, proof([row('x', false, { failure: 'assertion' })])), null);
});

test('clause 2: a load error, zero tests or a skip at base is not a failing run [C7]', () => {
  for (const base of [[row('x', false, { failure: 'error' })], [], [{ ...row('x', false), skipped: true }], [row('x', true)]]) {
    assert.match(clauseReceiptProblem(item, proof(base))?.message ?? '', /no recorded run that fails on an assertion/u);
  }
});

test('clause 3: the receipt is one thread note, stored once, and the show lines read it back [C7]', () => {
  const run = { gateFiles: new Set([FILE]), baseRows: [row('x', false, { failure: 'assertion' })], outcomes: [row('x', true)], head: HEAD, baseCommit: BASE };
  const [text] = clauseReceiptNotes(item, [], run);
  assert.match(text, /^receipt for clause 1: .* failed on an assertion at base bbbbbbbbbbbb \(x\) and passed at head cccccccccccc$/u);
  const thread = [{ type: 'fact', kind: 'note', text }];
  assert.deepEqual(clauseReceiptNotes(item, thread, run), [], 'a held receipt is not written twice');
  assert.deepEqual(clauseReceipts(thread).map(receipt => receipt.number), [1]);
  assert.deepEqual(clauseReceiptNotes(item, [], { ...run, outcomes: [row('x', false)] }), [], 'red at head leaves no receipt');
});
