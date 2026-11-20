/** @pullboard-test-input packages/codemap/src/io/cells/scripts/plan.js */
/** @pullboard-test-loads packages/codemap/src/io/cells/scripts/plan.js */
/** Engine leaves live in packages/state/src/logic/engines; a new src/<name>-engine.js has no plan row and is refused [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unplanned } from '../../../../codemap/index.js';
import { fixture } from '../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../landing/tests/fixtures/plan.js';

test('gate.io-edges-rule.a-new-src-zz-test-engine: clause 1: a new src/zz-test-engine.js is reported unplanned, so no engine leaf comes back to src/ [C7,V4]', t => {
  const { root, put } = fixture(t);
  const placed = git(root, 'ls-files').split('\n').filter(Boolean);
  const plan = { cells: [{ name: 'fixture', paths: placed.map(file => [file, file]) }], stays: [] };
  assert.deepEqual(unplanned(root, plan), []);
  put('src/zz-test-engine.js', 'export const ZZ_TEST_ENGINE = 1;\n');
  git(root, 'add', '-A');
  assert.deepEqual(unplanned(root, plan), ['src/zz-test-engine.js']);
});
