import test from 'node:test';
import assert from 'node:assert/strict';
import { ownersOf } from '../../../../index.js';
import { linkKnownMainReworks } from '../../../../index.js';
import { requireKnownMainReworks } from '../../../../index.js';

const failure = { file: 'test/example.test.js', name: 'other case [C7]', signature: 'a'.repeat(64) };
/** Build a synthetic repair row; this fixture asserts ownership rules, not an executed gate. */
function repair(id, pattern = '', criterion = '') {
  return { item_id: id, item_status: 'open', item_title: 'Main red: fixture',
    item_frozen: JSON.stringify({ check: `node apps/cli/src/io/run/tests.js ${pattern} test/example.test.js`, criterion }) };
}

test('case-named repair wins over a whole-file fallback [V4,B3,H16]', () => {
  assert.deepEqual(ownersOf(failure, [repair(1), repair(2, '', 'Fix other case')]).map(row => row.item_id), [2]);
});

test('one whole-file repair owns otherwise unnamed cases while frozen patterns stay bounded [V4,B3,H16]', () => {
  const items = [repair(1, "--test-name-pattern='specific case'"), repair(2)];
  assert.deepEqual(ownersOf(failure, items).map(row => row.item_id), [2]);
  assert.deepEqual(ownersOf(failure, [items[0]]), []);
  assert.deepEqual(ownersOf({ ...failure, name: 'specific case [C7]' }, [items[0]]).map(row => row.item_id), [1]);
  assert.deepEqual(ownersOf(failure, [repair(3, "--test-skip-pattern='other case'")]), []);
  assert.deepEqual(ownersOf(failure, [repair(4, "--test-name-pattern 'other case' --test-skip-pattern=never")]).map(row => row.item_id), [4]);
  assert.deepEqual(ownersOf(failure, [repair(5, "--test-name-pattern='['")]), []);
  assert.deepEqual(ownersOf(failure, [repair(6, '--test-name-pattern')]), []);
});

test('two whole-file repairs remain ambiguous and cannot seal an owner [V4,B3,H16]', () => {
  const known = { main: 'b'.repeat(40), failures: [failure] };
  const items = [repair(1), repair(2), repair(3, '--test-name-pattern=never')];
  assert.equal(linkKnownMainReworks(known, items), null);
  assert.throws(() => requireKnownMainReworks({ ...known, failures: [{ ...failure, item: 1 }] }, items), { code: 'SUBMISSION_PROOF' });
});

test('historical owner receipts keep their original selector semantics and bytes [V4,B3,H16]', () => {
  const items = [repair(1, '--test-name-pattern=unrelated')];
  const sealed = { main: 'b'.repeat(40), failures: [{ ...failure, item: 1 }] };
  const bytes = JSON.stringify(sealed);
  assert.doesNotThrow(() => requireKnownMainReworks(sealed, items, undefined, false));
  assert.throws(() => requireKnownMainReworks(sealed, items), { code: 'SUBMISSION_PROOF' });
  assert.equal(JSON.stringify(sealed), bytes);
  assert.deepEqual(ownersOf(failure, [items[0], repair(2)], undefined, false).map(row => row.item_id), [1, 2]);
});
