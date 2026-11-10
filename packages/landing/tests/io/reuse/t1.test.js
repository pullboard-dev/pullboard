/**
 * Landing reuses a green submit proof's files whose closure is unchanged and reruns only deferred journeys and files
 * whose closure moved [C7,#3801].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reusableSubmitFiles } from '../../../src/io/reuse.js';

const proof = { files: ['test/a.test.js', 'test/b.test.js', 'test/j.test.js'], deferredFiles: ['test/j.test.js'], deferred: true };

test('clause 1: a deferred proof reuses unchanged-closure files and reruns only the deferred journey [C7,#3801]', () => {
  const { reuse, rerun } = reusableSubmitFiles({ proof, closureUnchanged: () => true });
  assert.deepEqual(reuse, ['test/a.test.js', 'test/b.test.js']);
  assert.deepEqual(rerun, ['test/j.test.js']);
});

test('clause 2: a file whose closure changed between submit and landing is rerun [C7,#3801]', () => {
  const { reuse, rerun } = reusableSubmitFiles({ proof, closureUnchanged: file => file !== 'test/b.test.js' });
  assert.deepEqual(reuse, ['test/a.test.js']);
  assert.deepEqual(rerun, ['test/b.test.js', 'test/j.test.js']);
});

test('no proof reuses nothing [C7,#3801]', () => {
  assert.deepEqual(reusableSubmitFiles({ proof: null, closureUnchanged: () => true }), { reuse: [], rerun: [] });
});
