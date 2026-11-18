/** @pullboard-test-input source-cell seats */
/** A pure check names a strong item as light-shaped by clause count, check files and brief files [C7,#2975]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lightShaped } from '../../../index.js';

const base = {
  item_criterion: '1. packages/seats/tests/logic/route/shaped.test.js: a case [test]',
  item_check: 'node --test packages/seats/tests/logic/route/shaped.test.js',
  item_brief: 'New pure file packages/seats/src/logic/route/shaped.js beside escalation.js.',
};

test('seats.route.light-shaped-limits: clause 1: lightShaped is true for one clause, one test file and at most two brief files, and false when any limit is exceeded [C7]', () => {
  assert.equal(lightShaped(base), true);
  assert.equal(lightShaped({ ...base, item_check: 'tests.js packages/seats/tests/logic/route/shaped.test.js' }), true);
  assert.equal(lightShaped({ ...base, item_brief: 'Edit a.js and b.json only.' }), true);
  assert.equal(lightShaped({ ...base, item_brief: 'No files named.' }), true);
  assert.equal(lightShaped({ ...base, item_criterion: `${base.item_criterion}. 2. Another [test]` }), false);
  assert.equal(lightShaped({ ...base, item_check: 'node --test packages/a/tests/x.test.js packages/b/tests/y.test.js' }), false);
  assert.equal(lightShaped({ ...base, item_check: '' }), false);
  assert.equal(lightShaped({ ...base, item_brief: 'Edit a.js, b.js and c.md.' }), false);
  assert.equal(lightShaped({}), false);
});
