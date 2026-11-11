/** Post-land red filing groups shared root causes without losing exact cases [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { postLandSuite } from '../../../../packages/landing/index.js';
import { unownedMainReds } from '../../../../packages/store/index.js';
import { laneOf } from '../../../../packages/seats/index.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

/** Run the production post-land filer against a private baseline and captured board writes. */
async function fileReds(t, failures, existing = []) {
  const folder = privateFixtureFiles('pb-cluster-').root;
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const added = [];
  const state = { board: {}, config: { lanes: { core: { owns: ['apps/'] } }, affectedTests: 'node packages/gate/src/io/run/tests.js' },
    batch: { id: 'batch-1', tip: 'a'.repeat(40), root: folder, items: [{ id: 4 }] }, say: () => {},
    write: async (operation, [item]) => { assert.equal(operation, 'addItem'); added.push(item); return added.length + 10; } };
  let current = [];
  const ports = { enabled: () => true, storePath: () => join(folder, 'baseline.json'),
    readItems: () => existing, laneOf, unownedMainReds,
    runSuite: async () => ({ green: current.length === 0, failures: current }) };
  await postLandSuite(state, ports);
  current = failures;
  state.batch = { ...state.batch, id: 'batch-2', tip: 'b'.repeat(40) };
  const result = await postLandSuite(state, ports);
  assert.equal(result.error, undefined);
  return { added, result };
}

test('one root frame files one cluster with every exact file and case [C7]', async t => {
  const stable = 'TypeError @ packages/example/src/common.js#read';
  const failures = [{ file: 'apps/a.test.js', name: 'first case', stable },
    { file: 'apps/b.test.js', name: 'second case', stable }];
  const { added, result } = await fileReds(t, failures);
  assert.equal(added.length, 1);
  assert.match(added[0].title, /^Red cluster:/u);
  for (const row of failures) {
    assert.ok(added[0].criterion.includes(`${row.file} :: ${row.name}`));
    assert.ok(added[0].check.includes(`'${row.file}'`));
  }
  assert.equal(result.filed.length, 2);
  assert.equal(result.filed[0].item, result.filed[1].item);
  const item = { item_id: 11, item_status: 'open', item_title: added[0].title,
    item_check: added[0].check, item_criterion: added[0].criterion };
  assert.deepEqual(unownedMainReds({ failures }, [item], null), [], 'cluster owns each recorded case');
});

test('distinct frames and generic assertions do not create a false cluster [C7]', async t => {
  const { added } = await fileReds(t, [
    { file: 'apps/a.test.js', name: 'a', stable: 'AssertionError @ packages/a.js#read' },
    { file: 'apps/b.test.js', name: 'b', stable: 'AssertionError @ packages/b.js#read' },
    { file: 'apps/c.test.js', name: 'c', firstError: 'Expected values to be strictly equal:' },
    { file: 'apps/d.test.js', name: 'd', firstError: 'Expected values to be strictly equal:' },
  ]);
  assert.equal(added.length, 4);
  assert.ok(added.every(item => item.title.startsWith('Main red:')));
});

test('a specific normalized error groups cases and an existing owner is never duplicated [C7]', async t => {
  const failures = ['a', 'b', 'c'].map(letter => ({ file: `apps/${letter}.test.js`, name: `case ${letter}`, firstError: 'ENOENT: missing manifest <root>/manifest.json' }));
  const existing = [{ item_id: 5, item_status: 'open', item_title: 'Main red: apps/a.test.js',
    item_check: "node test 'apps/a.test.js'", item_criterion: 'case a' }];
  const { added } = await fileReds(t, failures, existing);
  assert.equal(added.length, 1);
  assert.match(added[0].title, /^Red cluster:/u);
  assert.doesNotMatch(added[0].check, /apps\/a\.test\.js/u);
  assert.match(added[0].check, /apps\/b\.test\.js/u);
  assert.match(added[0].check, /apps\/c\.test\.js/u);
});
