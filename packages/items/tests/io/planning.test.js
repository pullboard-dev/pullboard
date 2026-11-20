/** Next selection predicts each in-flight item once per exact-main map and plans the same collisions as the per-pair lookups did [N2,N20,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemCollisionPlan } from '../../index.js';

/** One function per module, ids as the code map writes them (path#name). */
const fn = (path, name, calls = []) => ({ id: `${path}#${name}`, name, calls });

const MAP = {
  modules: [
    { path: 'packages/a/src/one.js', functions: [fn('packages/a/src/one.js', 'shared')], tests: ['packages/a/tests/one.test.js'] },
    { path: 'packages/c/src/caller.js', functions: [fn('packages/c/src/caller.js', 'caller', ['packages/c/src/callee.js#callee'])], tests: ['packages/c/tests/caller.test.js'] },
    { path: 'packages/c/src/callee.js', functions: [fn('packages/c/src/callee.js', 'callee')], tests: ['packages/c/tests/callee.test.js'] },
    { path: 'packages/d/src/caller.js', functions: [fn('packages/d/src/caller.js', 'caller', ['packages/d/src/callee.js#callee'])], tests: [] },
    { path: 'packages/d/src/callee.js', functions: [fn('packages/d/src/callee.js', 'callee')], tests: [] },
    { path: 'packages/e/src/solo.js', functions: [fn('packages/e/src/solo.js', 'solo')], tests: ['packages/e/tests/solo.test.js'] },
    { path: 'packages/f/src/other.js', functions: [fn('packages/f/src/other.js', 'other')], tests: [] },
    { path: 'packages/g/src/third.js', functions: [fn('packages/g/src/third.js', 'third')], tests: [] },
  ],
};

/** A board item row naming its files in the brief's Files section. */
const row = (id, files, status = 'submitted', title = 'work') => ({
  item_id: id, item_status: status, item_title: title, item_criterion: 'proof', item_files: '',
  item_brief: `Files:\n${files.map(file => `- ${file}`).join('\n')}\n\nTest:\n- tests/x.test.js\n`,
});

test('items.planning.same-plan: clause 1: on a fixture code map itemCollisionPlan returns the blockers, warnings and tests for a shared body, call-adjacent pairs with and without mapped tests, a disjoint pair and an unknown path that keeps file custody [N2,N20,C7]', () => {
  const candidate = row(1, ['packages/a/src/one.js', 'packages/c/src/caller.js']);
  const flying = [
    candidate,
    row(2, ['packages/a/src/one.js']),
    row(3, ['packages/c/src/callee.js']),
    row(4, ['packages/d/src/callee.js']),
    row(5, ['packages/e/src/solo.js']),
    row(6, ['packages/z/src/ghost.js'], 'claimed'),
    row(8, ['packages/e/src/solo.js'], 'open'),
  ];
  assert.deepEqual(itemCollisionPlan({}, candidate, flying, new Map(), MAP), {
    blockers: [
      '#1 waits for #2 (submitted) on functions packages/a/src/one.js#shared',
    ],
    warnings: [
      '#1 is call-adjacent to #3: packages/c/src/caller.js#caller -> packages/c/src/callee.js#callee; cross-run tests: packages/a/tests/one.test.js, packages/c/tests/callee.test.js, packages/c/tests/caller.test.js',
    ],
    tests: ['packages/a/tests/one.test.js', 'packages/c/tests/callee.test.js', 'packages/c/tests/caller.test.js'],
  });
  // A pair whose modules have no mapped tests waits, and an item that names only that pair is not held by the tested pair above.
  const untested = row(9, ['packages/d/src/caller.js']);
  assert.deepEqual(itemCollisionPlan({}, untested, [untested, ...flying.slice(1)], new Map(), MAP), {
    blockers: ['#9 waits for #4: call-adjacent functions have no mapped tests'],
    warnings: [],
    tests: [],
  });
  const ghost = row(7, ['packages/z/src/ghost.js']);
  assert.deepEqual(itemCollisionPlan({}, ghost, [ghost, ...flying.slice(1)], new Map(), MAP), {
    blockers: ['#7 waits for #6 (claimed) on packages/z/src/ghost.js'],
    warnings: [],
    tests: [],
  });
});

test('items.planning.predict-once: clause 1: 600 candidates against 3 in-flight items on one map read the map modules exactly 603 times, one per prediction [N2,N20,C7]', () => {
  let reads = 0;
  const counted = { get modules() { reads += 1; return MAP.modules; } };
  const flying = [row(2, ['packages/e/src/solo.js']), row(3, ['packages/f/src/other.js']), row(4, ['packages/g/src/third.js'])];
  for (let at = 0; at < 600; at += 1) {
    const candidate = row(1000 + at, ['packages/a/src/one.js'], 'open', `candidate ${at}`);
    assert.deepEqual(itemCollisionPlan({}, candidate, [candidate, ...flying], new Map(), counted), { blockers: [], warnings: [], tests: [] });
  }
  assert.equal(reads, 603);
});
