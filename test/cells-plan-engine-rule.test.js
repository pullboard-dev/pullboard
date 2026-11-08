/** @pullboard-test-input source-tree */
/** @pullboard-test-loads bin/cells-plan.js */
/** A new src/<name>-engine.js is placed by rule, never by a hand-written plan row [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computePlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { engineLeafPlacement } from '../packages/codemap/index.js';
import { runFixtureChild } from './fixture-child.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';

const BIN = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));

test('clause 1: a new src/zz-test-engine.js is placed by rule with the canonical engine reason and --check reports nothing unplanned [C7]', t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  put('src/zz-test-engine.js', 'export const ZZ_TEST_ENGINE = 1;\n');
  git(root, 'add', '-A');
  const run = runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(run.stdout + run.stderr, /not in bin\/cells-plan\.json: src\/zz-test-engine\.js/u);
  assert.deepEqual(engineLeafPlacement('src/zz-test-engine.js'),
    { path: 'src/zz-test-engine.js', reason: 'canonical feature engine identity; landing assigns its next number and freezes move history' });
  for (const other of ['src/engine.js', 'src/a/b-engine.js', 'lib/x-engine.js', 'src/x-engine.json']) assert.equal(engineLeafPlacement(other), null, other);
  put('src/zz-other.js', 'export const other = 1;\n');
  git(root, 'add', '-A');
  const unrelated = runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
  assert.match(unrelated.stdout + unrelated.stderr, /not in bin\/cells-plan\.json: src\/zz-other\.js/u, 'other new sources still need a row');
});
