/** A gate red only on cases a main receipt names for the same file and command passes as main's own red [C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeMainOwnedReds } from '../heavy.js';

const file = 'tests/red.test.js';
const command = 'node --test';
const tree = 'e'.repeat(40);
const base = { commit: 'c'.repeat(40), tree, at: 1000 };
const receipts = [{ id: 'j', tree, file, command, verdict: 'red', failing: ['main fails'], signatures: [null], main: 'c'.repeat(40), at: 1500 }];

test('gate.main-owned-reds.gate-red-only-case-main: clause 3: a gate red only on a case the main receipt names passes as main-owned; a case it does not name stays the candidate\'s own [C7,P7]', () => {
  const same = judgeMainOwnedReds({ base, command, reds: [{ file, name: 'main fails' }], receipts });
  assert.equal(same.verdict, 'green');
  assert.equal(same.mainOwned.length, 1);
  const other = judgeMainOwnedReds({ base, command, reds: [{ file, name: 'main fails' }, { file, name: 'new case' }], receipts });
  assert.equal(other.verdict, 'red');
});
