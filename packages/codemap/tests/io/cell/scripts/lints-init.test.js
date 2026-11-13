/** @pullboard-test-input packages/codemap/src/io/cell/scripts/lints.js */
/** Initializing the cell lint baseline stages its new shards so the verify can see them [C7,CD64]. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../../../../gate/tests/fixtures/child.js';
import { fixture } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';

const BIN = fileURLToPath(new URL('../../../../src/io/cell/scripts/lints.js', import.meta.url));

test('lints.js --init stages the baseline directory so a fresh baseline verifies without CELL_BASELINE, clause 1 [C7,CD64]', t => {
  const { root } = fixture(t);
  const initial = runFixtureChild(process.execPath, [BIN, '--init', root], { encoding: 'utf8', maxBuffer: 256 * 1024 ** 2 });
  assert.equal(initial.status, 0, initial.stderr);
  assert.doesNotMatch(initial.stderr, /CELL_BASELINE/u);
  const tracked = git(root, 'ls-files', 'packages/codemap/data/baselines/lints');
  assert.match(tracked, /baselines\/lints\/index\.json/u, 'the descriptor is staged');
  assert.match(tracked, /baselines\/lints\/.+-\d+\.json/u, 'every shard is staged');
});
