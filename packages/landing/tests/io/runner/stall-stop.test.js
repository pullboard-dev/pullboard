/** With landing.stallStop on, a land job whose check shows no progress for 120000 ms on an injected clock is stopped and records the stall; one that progresses keeps running [C7,#8749]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { LANDING_STALL_MS } from '../../../src/io/progress.js';
import { landingStallDescription } from '../../../src/io/progress.js';
import { runLandingJob } from '../../../index.js';

const ITEM = 52;

/** A bare trunk remote holding main and one accepted item commit that adds its own file. */
function landFixture(t, extra = {}) {
  const { root: dir } = privateFixtureFiles('pullboard-stall-stop-');
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
  const payload = { remote, trunk: 'refs/heads/main', expect: tip(), publish: 'separate', items: [{ id: ITEM, commit, ref: `refs/heads/item-${ITEM}` }], ...extra };
  return { payload, tip, workdir: join(dir, 'runner') };
}

/** An injected clock the check moves forward by hand; `looks(n)` settles once the stall watch has read it n more times. */
function clockAt() {
  let now = 1_000_000, reads = 0;
  const waiters = [];
  return {
    now: () => { reads++; for (const waiter of waiters.splice(0)) if (reads >= waiter.at) waiter.resolve(); else waiters.push(waiter); return now; },
    advance: ms => { now += ms; },
    looks: count => new Promise(resolve => waiters.push({ at: reads + count, resolve })),
  };
}

test('clause 1: a land job with no progress for 120000 ms stops and records the landingStallDescription reason [C7,#8749]', async t => {
  const box = landFixture(t, { stallStop: true });
  const before = box.tip();
  const clock = clockAt();
  let stopped = false;
  const checks = ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { stopped = true; resolve({ ok: false }); });
    clock.advance(LANDING_STALL_MS);
  });
  const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks, clock: clock.now, stallPollMs: 5 });
  assert.equal(receipt.outcome, 'proof-timeout');
  assert.equal(stopped, true, 'the check was told to stop');
  assert.ok(receipt.detail.includes(landingStallDescription({ id: `land:${ITEM}`, state: 'checking' }, 'check')), receipt.detail);
  assert.equal(box.tip(), before, 'a stalled landing moves nothing');
  assert.deepEqual(receipt.returned, [], 'no item goes back to its builder');
});

test('clause 2: a land job that progresses inside the window keeps running and lands [C7,#8749]', async t => {
  const box = landFixture(t, { stallStop: true });
  const before = box.tip();
  const clock = clockAt();
  const checks = async ({ progress }) => {
    for (let step = 0; step < 4; step++) {
      clock.advance(LANDING_STALL_MS - 1);
      progress();
      await clock.looks(2);
    }
    return { ok: true };
  };
  const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks, clock: clock.now, stallPollMs: 5 });
  assert.equal(receipt.outcome, 'landed');
  assert.notEqual(box.tip(), before);
});

test('clause 1: with landing.stallStop off, a quiet check is never stopped [C7,#8749]', async t => {
  const box = landFixture(t);
  const clock = clockAt();
  const checks = async () => { clock.advance(10 * LANDING_STALL_MS); return { ok: true }; };
  const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks, clock: clock.now, stallPollMs: 5 });
  assert.equal(receipt.outcome, 'landed');
});
