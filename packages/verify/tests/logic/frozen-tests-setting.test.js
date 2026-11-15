/** verify.frozenTests gates only the TEST_HASH_CHANGED refusal; hashes are recorded and shown either way [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configProblems } from '../../../config/src/io/main.js';
import { defaults } from '../../../config/src/io/main.js';
import { contentHash } from '../../index.js';
import { frozenTestsProblem } from '../../index.js';
import { namedTestHashes } from '../../index.js';

const item = {
  item_id: 7,
  item_criterion: '1. a/one.test.js passes [test]',
  item_frozen: JSON.stringify({ testHashes: { 'a/one.test.js': contentHash('one') } }),
};
const changed = { atHead: () => 'weaker', atMain: () => 'one', person: 'person' };

test('clause 1: with verify.frozenTests unset or false, a changed named test file is accepted [C7]', () => {
  assert.equal(defaults().verify.frozenTests, false);
  assert.equal(frozenTestsProblem(undefined, item, [], changed), null);
  assert.equal(frozenTestsProblem({}, item, [], changed), null);
  assert.equal(frozenTestsProblem(defaults().verify, item, [], changed), null);
});

test('clause 2: with verify.frozenTests true, the changed file is refused with TEST_HASH_CHANGED [C7]', () => {
  assert.equal(frozenTestsProblem({ frozenTests: true }, item, [], changed)?.code, 'TEST_HASH_CHANGED');
  assert.equal(frozenTestsProblem({ frozenTests: true }, item, [], { ...changed, atHead: () => 'one' }), null, 'unchanged still passes');
  const bad = { ...defaults(), verify: { ...defaults().verify, frozenTests: 'yes' } };
  assert.ok(configProblems(bad).some(problem => problem.includes('frozenTests')));
});

test('clause 3: the frozen hash of each named test file is still recorded whatever the setting [C7]', () => {
  assert.deepEqual(namedTestHashes({ item_criterion: item.item_criterion }, path => (path === 'a/one.test.js' ? 'one' : null)), { 'a/one.test.js': contentHash('one') });
});
