/** @pullboard-test-input packages/landing/src/io/runner/job.js */
/** @pullboard-test-input packages/landing/src/io/step/publish.js */
/** @pullboard-test-input packages/landing/src/io/land/fence.js */
/** With gate.fencedHop on, the runner land job carries each item's hop epoch and pushes trunk and refs/pullboard/hop/<item> in one atomic push [C7,#8437]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runLandingJob } from '../../../index.js';
import { fenceHop } from '../../../src/io/step/publish.js';
import { hopFenceObject } from '../../../src/io/land/fence.js';
import { hopFenceRef } from '../../../src/io/land/fence.js';

const ITEM = 41;

/**
 * A bare trunk remote holding main and one accepted item commit, whose pre-receive hook logs each push's ref updates as one line,
 * and a land payload for the item carrying hop epoch `epoch`.
 */
function landFixture(t, epoch) {
  const { root: dir } = privateFixtureFiles('pullboard-land-hop-');
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
  const pushes = join(dir, 'pushes.log');
  writeFileSync(pushes, '');
  writeFileSync(join(remote, 'hooks', 'pre-receive'), `#!/bin/sh\necho $(cut -d' ' -f3) >> '${pushes}'\n`);
  chmodSync(join(remote, 'hooks', 'pre-receive'), 0o755);
  const ref = name => git(dir, '--git-dir', remote, 'for-each-ref', '--format=%(objectname)', name).trim();
  const payload = { shape: 3, remote, trunk: 'refs/heads/main', expect: ref('refs/heads/main'), publish: 'separate', items: [{ id: ITEM, commit, ref: `refs/heads/item-${ITEM}` }], hops: [{ item: ITEM, epoch }] };
  return { work, remote, payload, workdir: join(dir, 'runner'), tip: () => ref('refs/heads/main'), fence: () => ref(hopFenceRef(ITEM)), pushes: () => readFileSync(pushes, 'utf8').trim().split('\n').filter(Boolean).map(line => line.trim().split(/\s+/u).sort().join(' ')) };
}

test('clause 1: with gate.fencedHop on, the runner land job moves refs/pullboard/hop/<item> to the item epoch in the same push as trunk [C7,#8437]', async t => {
  const box = landFixture(t, 2);
  fenceHop(box.work, { remote: box.remote, item: ITEM, epoch: 1 });
  const before = box.pushes().length;
  const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) });
  assert.equal(receipt.outcome, 'landed');
  assert.deepEqual(receipt.landed, [ITEM]);
  assert.equal(box.tip(), receipt.trunk, 'trunk moved to the landed tip');
  assert.equal(box.fence(), hopFenceObject(box.work, { item: ITEM, epoch: 2 }), 'the fence names the item epoch the job carried');
  assert.deepEqual(box.pushes().slice(before), [`refs/heads/main ${hopFenceRef(ITEM)}`], 'one push moved the fence and trunk together');
});

test('clause 2: a runner land job holding a stale epoch is refused HOP_FENCED and leaves trunk unmoved [C7,#8437]', async t => {
  const box = landFixture(t, 2);
  // A newer gate owner took the hop at epoch 3 and moved the fence; this job still carries epoch 2.
  const newer = fenceHop(box.work, { remote: box.remote, item: ITEM, epoch: 3 });
  const before = box.tip();
  await assert.rejects(runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) }), error => {
    assert.equal(error.code, 'HOP_FENCED');
    assert.match(error.message, new RegExp(`#${ITEM} at hop epoch 2.*${newer.slice(0, 12)}`, 'u'), 'the refusal names the stale epoch and the fence the remote holds');
    return true;
  });
  assert.equal(box.tip(), before, 'trunk did not move');
  assert.equal(box.fence(), newer, 'the fence stays with the newer owner');
});

test('clause 1: a land job with no hops pushes trunk alone and writes no fence ref [C7,#8437]', async t => {
  const box = landFixture(t, 1);
  const { hops, ...plain } = box.payload;
  const receipt = await runLandingJob({ ...plain, shape: 2 }, { workdir: box.workdir, checks: () => ({ ok: true }) });
  assert.equal(receipt.outcome, 'landed');
  assert.equal(box.fence(), '', 'no fence ref was written');
  assert.equal(hops.length, 1);
});
