/** @pullboard-test-input source-tree */
/** @pullboard-test-loads bin/cells-plan.js */
/** The plan writer keeps explicit migration contracts without retaining obsolete generated shards [C7,D3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { computePlan } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { runFixtureChild } from './fixture-child.js';
import { fixture } from './cells-plan-fixture.js';

const BIN = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));

test('plan --write preserves exact temporary edge contracts while removing stale plan shards [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  const file = 'bin/cells-plan/temporary-edges.json';
  const contracts = JSON.stringify({ version: 1, edges: [{ importer: 'src/board.js', target: 'src/claims.js', contractItem: 1624, expires: '2099-01-01' }] }, null, 2) + '\n';
  put(file, contracts);
  put('bin/cells-plan/99-obsolete.json', '{}\n');
  const run = runFixtureChild(process.execPath, [BIN, '--write'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(root, file)), true, 'regeneration retains the live migration contract file');
  assert.equal(readFileSync(join(root, file), 'utf8'), contracts, 'regeneration neither drops nor rewrites contract bytes');
  assert.equal(existsSync(join(root, 'bin/cells-plan/99-obsolete.json')), false, 'obsolete generated shards are still pruned');
  assert.deepEqual(readPlan(root), JSON.parse(JSON.stringify(computePlan(root))), 'the generated plan remains complete');
});
