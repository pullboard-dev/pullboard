/** A land job's receipt records the proof and the contracts phase in milliseconds beside merge and push, red or green [C7,#9245]. */
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

test('clause 1: a finished land job records proof and contracts ms beside merge and push [C7,#9245]', async t => {
  const box = landFixture(t);
  const receipt = await runLandingJob({ ...box.payload, check: ['sh', '-c', 'sleep 0.05'], contracts: { runner: 'true' } }, { workdir: box.workdir });
  assert.equal(receipt.outcome, 'landed');
  for (const phase of ['merge', 'proof', 'contracts', 'push']) {
    assert.equal(named(receipt, phase).length, 1, `${phase} recorded once`);
    assert.ok(Number.isFinite(named(receipt, phase)[0].ms) && named(receipt, phase)[0].ms >= 0, `${phase} has ms`);
  }
  assert.ok(named(receipt, 'proof')[0].ms >= 40, 'the proof ms covers the command it ran');
});

test('clause 2: a red proof still records the proof ms it spent [C7,#9245]', async t => {
  const box = landFixture(t);
  const receipt = await runLandingJob({ ...box.payload, check: ['sh', '-c', 'sleep 0.05; exit 1'] }, { workdir: box.workdir });
  assert.notEqual(receipt.outcome, 'landed');
  assert.equal(named(receipt, 'proof').length, 1, 'the red proof recorded its phase');
  assert.ok(named(receipt, 'proof')[0].ms >= 40);
  assert.equal(named(receipt, 'contracts').length, 0, 'contracts never ran after a red proof');
});
