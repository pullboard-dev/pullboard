/** @pullboard-test-input source-tree */
/** A real deterministic Submit never acquires automatic quarantine, and the pair selector keeps its boundaries [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/cases/quarantine-submit.js';
import { snapshot } from '../../tests/fixtures/cases/quarantine-submit.js';
import { submit } from '../../tests/fixtures/cases/quarantine-submit.js';
import { submitFlakePairs } from '../../../../packages/flakes/index.js';

test('clause 1: a real deterministic Submit original and rerun never acquire automatic quarantine [C7,H16]', t => {
  const box = fixture(t, true);
  const first = submit(box);
  assert.ok([0, 1].includes(first.code), JSON.stringify(first.document));
  assert.ok(box.readData(box.counter, 'utf8').trim().split('\n').length >= 2, 'the actual deterministic original and paired bodies executed: ' + JSON.stringify(first.document));
  assert.deepEqual(snapshot(box).quarantines, []);
  if (first.code === 1) {
    const second = submit(box);
    assert.ok([0, 1].includes(second.code), JSON.stringify(second.document));
    assert.deepEqual(snapshot(box).quarantines, []);
  }
});

/** Synthetic pure selector input explicitly tests historical time/identity boundaries, never execution authority. */
function synthetic(admission, passed, at, { tree = 'a', diagnostic = passed, skipped = false } = {}) {
  return { id: `${admission}-${passed}-${at}`, version: 2, kind: diagnostic ? 'check' : 'submit', tree,
    at, proof: { seat: 'synthetic', item: 1, frozenDigest: diagnostic ? null : 'bar', sourceClean: true,
      exitCode: passed ? 0 : 1, diagnosticAdmission: admission, ...(diagnostic ? { submitPhase: 'diagnostic' } : {}) },
    testOutcomes: [{ file: 'test/synthetic.js', name: 'synthetic case', passed, skipped }] };
}

test('clause 1: synthetic selector boundaries reject repeated admission, reversed order, changed trees, skips and expired pairs [C7,H16]', () => {
  const time = '2026-10-30T10:00:00.000Z';
  const red = synthetic('one', false, '2026-10-30T09:00:00.000Z');
  const green = synthetic('one', true, '2026-10-30T09:01:00.000Z');
  const select = runs => submitFlakePairs(runs, 'test/synthetic.js', 'synthetic case', time);
  assert.equal(select([red, green, red, green]).length, 1);
  assert.equal(select([red, synthetic('two', false, green.at)]).length, 0, 'repeated deterministic reds never complete a pair');
  assert.equal(select([red, { ...green, tree: 'different' }]).length, 0);
  assert.equal(select([green, { ...red, at: '2026-10-30T09:02:00.000Z' }]).length, 0);
  assert.equal(select([red, synthetic('one', true, green.at, { skipped: true })]).length, 0);
  assert.equal(select([red, synthetic('one', true, green.at, { diagnostic: false })]).length, 0);
  assert.equal(submitFlakePairs([red, green], 'test/synthetic.js', 'synthetic case', '2026-11-01T10:00:00.000Z').length, 0);
  const another = [synthetic('two', false, '2026-10-30T09:03:00.000Z', { tree: 'b' }), synthetic('two', true, '2026-10-30T09:04:00.000Z', { tree: 'b' })];
  assert.equal(select([red, green, ...another]).length, 2, 'each Submit pair keeps its own unchanged tree');
});
