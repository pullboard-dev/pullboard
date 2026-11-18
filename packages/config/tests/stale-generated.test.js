/** A pure function names the declared generated files a change makes stale [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staleGeneratedFiles } from '../src/logic/generated.js';

const generated = [
  { file: 'docs/api.md', generator: 'node tools/make-api.js', inputs: ['src/api.js', 'tools/make-api.js'] },
  { file: 'docs/cli.md', generator: 'node tools/make-cli.js', inputs: ['src/cli.js'] },
];

test('config.stale-generated.clause-1-a-changed-input-names-each: clause 1: a changed input names each declared generated file made stale [C7]', () => {
  assert.deepEqual(staleGeneratedFiles(generated, ['src/api.js', 'README.md']).map(entry => entry.file), ['docs/api.md']);
  assert.deepEqual(staleGeneratedFiles(generated, ['src/cli.js', 'tools/make-api.js']).map(entry => entry.file), ['docs/api.md', 'docs/cli.md']);
});

test('config.stale-generated.clause-2-it-returns-nothing-when-no: clause 2: it returns nothing when no declared input changed [C7]', () => {
  assert.deepEqual(staleGeneratedFiles(generated, ['README.md', 'docs/api.md']), []);
  assert.deepEqual(staleGeneratedFiles(generated, []), []);
  assert.deepEqual(staleGeneratedFiles(undefined, ['src/api.js']), []);
});
