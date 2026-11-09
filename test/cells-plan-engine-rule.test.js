/** @pullboard-test-input source-tree */
/** @pullboard-test-loads bin/cells-plan.js */
/** Engine leaves live in packages/state/src/core/engines; a new src/<name>-engine.js has no plan row and is refused [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computePlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { runFixtureChild } from './fixture-child.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';

const BIN = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));

test('clause 1: a new src/zz-test-engine.js is reported unplanned, so no engine leaf comes back to src/ [C7,V4]', t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  put('src/zz-test-engine.js', 'export const ZZ_TEST_ENGINE = 1;\n');
  git(root, 'add', '-A');
  const run = runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
  assert.match(run.stdout + run.stderr, /not in bin\/cells-plan\.json: src\/zz-test-engine\.js/u);
});
