/** @pullboard-test-input source-cell landing */
/** A land job's receipt times the item fetches and the trunk fetch as phases beside merge and push [C7,#9545]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runLandingJob } from '../../../index.js';

const ITEM = 41;

/** A bare trunk remote holding main and one accepted item commit that adds its own file. */
function landFixture(t) {
  const { root: dir } = privateFixtureFiles('pullboard-land-phase-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { root: work, put } = fixture(t);
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  git(work, 'checkout', '-q', '-b', 'item');
  put('item.txt', 'item\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'feat: item [C7]');
  const commit = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'push', '-q', remote, 'main:refs/heads/main', `item:refs/heads/item-${ITEM}`);
  const tip = () => git(dir, '--git-dir', remote, 'rev-parse', 'refs/heads/main').trim();
  const payload = { remote, trunk: 'refs/heads/main', expect: tip(), publish: 'separate', items: [{ id: ITEM, commit, ref: `refs/heads/item-${ITEM}` }] };
  return { payload, workdir: join(dir, 'runner') };
}

/** The named phases of a receipt, each as ms. */
const named = (receipt, phase) => receipt.phases.filter(row => row.phase === phase);

test('clause 1: the receipt of runLandingJob lists a fetch items phase and a fetch trunk phase with their milliseconds [C7,#9545]', async t => {
  const box = landFixture(t);
  const receipt = await runLandingJob({ ...box.payload, check: ['sh', '-c', 'true'] }, { workdir: box.workdir });
  assert.equal(receipt.outcome, 'landed');
  for (const phase of ['fetch items', 'fetch trunk']) {
    assert.equal(named(receipt, phase).length, 1, `${phase} recorded once`);
    assert.ok(Number.isFinite(named(receipt, phase)[0].ms) && named(receipt, phase)[0].ms >= 0, `${phase} has ms`);
  }
  const order = receipt.phases.map(row => row.phase);
  assert.ok(order.indexOf('fetch items') < order.indexOf('fetch trunk') && order.indexOf('fetch trunk') < order.indexOf('merge'), 'fetches are listed before the merge');
});

test('clause 1: an item that moved still records the fetch items phase [C7,#9545]', async t => {
  const box = landFixture(t);
  const payload = { ...box.payload, items: [{ ...box.payload.items[0], commit: '0'.repeat(40) }] };
  const receipt = await runLandingJob({ ...payload, check: ['sh', '-c', 'true'] }, { workdir: box.workdir });
  assert.equal(receipt.outcome, 'item-moved');
  assert.equal(named(receipt, 'fetch items').length, 1);
});
