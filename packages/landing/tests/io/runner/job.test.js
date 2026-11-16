/** A land job stops on RUNNER_SOURCE without moving trunk, retries a landing fault, and reuses a landing trunk already holds [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { retryableLandingRefusal } from '../../../index.js';
import { runLandingJob } from '../../../index.js';
import { runnerSourceHold } from '../../../index.js';

const ITEM = 41;

/** A bare trunk remote holding main and one accepted item commit that adds its own file. */
function landFixture(t) {
  const { root: dir } = privateFixtureFiles('pullboard-land-job-');
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
  return { dir, payload, tip, workdir: join(dir, 'runner') };
}

/** The refusal a runner raises when its checkout is not the queued candidate. */
const sourceRefusal = () => Object.assign(new Error('the runner checkout is not the queued candidate'), { code: 'RUNNER_SOURCE' });

test('clause 1: RUNNER_SOURCE stops the land job with trunk unmoved, and three refusals on one base hold the item [C7]', async t => {
  const box = landFixture(t);
  const before = box.tip();
  const batches = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(runLandingJob(box.payload, { workdir: box.workdir, checks: () => { throw sourceRefusal(); } }),
      error => { batches.push({ state: 'blocked', base: before, candidates: [{ id: ITEM, commit: box.payload.items[0].commit }], refusal: { code: error.code, message: error.message } }); return error.code === 'RUNNER_SOURCE'; });
    assert.equal(box.tip(), before, 'a refused landing never moves trunk');
  }
  const held = runnerSourceHold(batches, { item_id: ITEM, item_commit: box.payload.items[0].commit }, before);
  assert.equal(held.code, 'LAND_RUNNER_SOURCE_HELD');
  assert.equal(runnerSourceHold(batches.slice(0, 2), { item_id: ITEM, item_commit: box.payload.items[0].commit }, before), null, 'two refusals still retry');
});

test('clause 1: a landing fault is retryable and the next land job lands the same item [C7,#3693]', async t => {
  const box = landFixture(t);
  const before = box.tip();
  const fault = Object.assign(new Error('every shard was refused by the runner'), { code: 'LAND_RUNNER_FAULT' });
  await assert.rejects(runLandingJob(box.payload, { workdir: box.workdir, checks: () => { throw fault; } }), error => error.code === 'LAND_RUNNER_FAULT' && retryableLandingRefusal(error.code));
  assert.equal(box.tip(), before, 'the fault landed nothing');
  const retry = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) });
  assert.equal(retry.outcome, 'landed');
  assert.deepEqual(retry.landed, [ITEM]);
  assert.notEqual(box.tip(), before, 'the retry moved trunk');
});

test('clause 1: a landing whose item trunk already holds reuses it, runs no check and moves nothing [C7]', async t => {
  const box = landFixture(t);
  const first = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) });
  assert.deepEqual(first.landed, [ITEM]);
  const landed = box.tip();
  let checks = 0;
  const again = await runLandingJob({ ...box.payload, expect: landed }, { workdir: box.workdir, checks: () => { checks += 1; return { ok: false, detail: 'must not run' }; } });
  assert.equal(again.outcome, 'landed');
  assert.deepEqual([again.already, again.landed, checks], [[ITEM], [], 0], 'the landed receipt is reused, no gate runs');
  assert.equal(box.tip(), landed, 'trunk stays where the first landing put it');
});
