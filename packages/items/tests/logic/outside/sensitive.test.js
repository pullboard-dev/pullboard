/** An outside change to gate, landing or merge code is sensitive, and the list is derived from the package folders [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OUTSIDE_SENSITIVE_PATHS } from '../../../index.js';
import { SENSITIVE_CELLS } from '../../../index.js';
import { outsideSensitivePaths } from '../../../index.js';
import { outsideSensitivity } from '../../../index.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const mainPolicy = () => ({ version: 1, commit: 'HEAD', config: {} });

test('items.logic-outside-sensitive.cells-from-folders: clause 1: [C7] the sensitive list is the fixed boundaries plus one package folder per sensitive cell, derived with no cells plan read', () => {
  const list = outsideSensitivePaths();
  const fixed = OUTSIDE_SENSITIVE_PATHS.length;
  assert.deepEqual(list.slice(0, fixed), [...OUTSIDE_SENSITIVE_PATHS]);
  assert.deepEqual(list.slice(fixed), SENSITIVE_CELLS.map(name => `packages/${name}/`).sort());
  assert.ok(!list.includes('packages/codemap/data/plan/cells.json') && !OUTSIDE_SENSITIVE_PATHS.includes('packages/codemap/data/plan/'), 'the plan folder is not a sensitive entry');
});

test('items.sensitive.outside-change-marked: clause 2: [C7] an outside change under the gate or landing package folder is marked sensitive', () => {
  const paths = ['packages/gate/src/io/submit.js', 'packages/landing/src/io/computed/conflict/return.js'];
  const reasons = outsideSensitivity(ROOT, 'HEAD', 'HEAD', paths, { mainPolicy });
  for (const path of paths) {
    assert.ok(reasons.some(reason => reason.path === path && reason.rule === 'declared-sensitive-path'), `${path} is marked sensitive`);
  }
});
