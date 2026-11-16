/** The frozen test hashes: what is hashed, what counts as a change, and what a person's ruling covers [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedTestFiles } from '../../index.js';
import { contentHash } from '../../index.js';
import { frozenTestHashes } from '../../index.js';
import { namedTestHashes } from '../../index.js';
import { testHashProblem } from '../../index.js';

const files = { 'a/one.test.js': 'one', 'a/two.test.js': 'two' };
const item = { item_id: 7, item_criterion: '1. a/one.test.js and a/new.test.js pass [test]. 2. A/b.txt exists.' };

test('verify.hash.named-only: clause 1: only existing test files the criterion names are hashed [C7,V4]', () => {
  assert.deepEqual(namedTestHashes(item, path => files[path] ?? null), { 'a/one.test.js': contentHash('one') });
});

test('verify.hash.kept: clause 1: a hash already frozen is kept, not read again [C7,V4]', () => {
  assert.deepEqual(namedTestHashes(item, () => null, { 'a/one.test.js': 'f'.repeat(64) }), { 'a/one.test.js': 'f'.repeat(64) });
});

test('verify.hash.change: clause 2: a builder edit is a change, an identical or main-supplied content is not [C7,V4]', () => {
  const frozen = { 'a/one.test.js': contentHash('one') };
  const main = () => 'one-on-main';
  assert.deepEqual(changedTestFiles(frozen, () => 'one', main), []);
  assert.deepEqual(changedTestFiles(frozen, () => 'one-on-main', main), [], 'main moved the file, not the builder');
  assert.deepEqual(changedTestFiles(frozen, () => 'weaker', main).map(change => change.now), [contentHash('weaker')]);
  assert.deepEqual(changedTestFiles(frozen, () => null, () => 'one').map(change => change.now), [null], 'a deleted file is a change');
});

test('verify.hash.ruling: clauses 2 and 3: the refusal names the file, and only a person ruling on that exact content lifts it [C7,V4]', () => {
  const frozenItem = { ...item, item_frozen: JSON.stringify({ testHashes: { 'a/one.test.js': contentHash('one') } }) };
  const source = { atHead: () => 'weaker', atMain: () => 'one', person: 'person' };
  const ruling = (by, text) => ({ type: 'fact', kind: 'decision', by, id: 'f1', text });
  const refusal = testHashProblem(frozenItem, [], source);
  assert.equal(refusal.code, 'TEST_HASH_CHANGED');
  assert.match(refusal.message, /a\/one\.test\.js/u);
  const text = `test-hash a/one.test.js ${contentHash('weaker')}`;
  assert.equal(testHashProblem(frozenItem, [ruling('web-1', text)], source)?.code, 'TEST_HASH_CHANGED', 'an agent cannot rule');
  assert.equal(testHashProblem(frozenItem, [ruling('person', `test-hash a/one.test.js ${contentHash('other')}`)], source)?.code, 'TEST_HASH_CHANGED', 'a ruling covers one content');
  assert.equal(testHashProblem(frozenItem, [ruling('person', text)], source), null);
});

test('verify.hash.no-hashes: clause 2: a bar frozen without hashes freezes nothing [C7,V4]', () => {
  assert.deepEqual(frozenTestHashes({ item_frozen: '{"criterion":"x"}' }), {});
  assert.equal(testHashProblem(item, [], { atHead: () => 'x', atMain: () => 'y', person: 'person' }), null);
});
