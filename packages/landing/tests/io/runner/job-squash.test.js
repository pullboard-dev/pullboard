/** @pullboard-test-input packages/landing/src/io/runner/job.js */
/** @pullboard-test-input packages/landing/src/io/land/squash.js */
/** With landing.squash on, the runner land job lands each item as one single-parent commit; off, as the --no-ff merge [C7,#9219]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runLandingJob } from '../../../index.js';

const IDS = [51, 52];

/** A bare trunk remote holding main and two accepted item branches (two commits on the first), and the land payload for both. */
function landFixture(t) {
  const { root: dir } = privateFixtureFiles('pullboard-land-squash-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { root: work, put } = fixture(t);
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  const tips = {};
  for (const id of IDS) {
    git(work, 'checkout', '-q', '-b', `item-${id}`, 'main');
    put(`item-${id}.txt`, `${id}\n`);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `feat: item ${id} first [C7]`);
    if (id === IDS[0]) {
      put('extra.txt', 'extra\n');
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '-m', `feat: item ${id} second [C7]`);
    }
    tips[id] = git(work, 'rev-parse', 'HEAD').trim();
    git(work, 'push', '-q', remote, `item-${id}:refs/heads/item-${id}`);
  }
  git(work, 'push', '-q', remote, 'main:refs/heads/main');
  const ref = name => git(dir, '--git-dir', remote, 'for-each-ref', '--format=%(objectname)', name).trim();
  const items = IDS.map(id => ({ id, commit: tips[id], ref: `refs/heads/item-${id}`, header: `feat(landing): item ${id} [C7]`, trailers: `Pullboard-Item: #${id}\nPullboard-Rows: C7` }));
  const payload = { shape: 3, remote, trunk: 'refs/heads/main', expect: ref('refs/heads/main'), publish: 'separate', items };
  const rev = (...args) => git(dir, '--git-dir', remote, ...args).trim();
  return { dir, remote, payload, tips, base: payload.expect, workdir: join(dir, 'runner'), rev, ref };
}

/** Run the land job as the board offers it: payload.squash is landing.squash, set only when the setting is on (apps/cli landing/pull.js). */
function landWith(box, squash) {
  return runLandingJob(squash ? { ...box.payload, squash: true } : box.payload, { workdir: box.workdir, checks: () => ({ ok: true }) });
}

test('clause 1: with landing.squash on, a land job for two items leaves two single-parent commits with their trailers, and refs/pullboard/items/<id> reaches each item commit [C7,#9219]', async t => {
  const box = landFixture(t);
  const receipt = await landWith(box, true);
  assert.equal(receipt.outcome, 'landed');
  assert.deepEqual(receipt.landed, IDS);
  const added = box.rev('rev-list', '--format=%H', `${box.base}..refs/heads/main`).split('\n').filter(line => /^[0-9a-f]{40}$/u.test(line));
  assert.equal(added.length, 2, 'main gained exactly two commits');
  for (const [index, sha] of added.reverse().entries()) {
    const id = IDS[index];
    assert.equal(box.rev('rev-list', '--parents', '-n1', sha).split(' ').length, 2, `#${id} has one parent`);
    const message = box.rev('log', '-1', '--format=%B', sha);
    assert.match(message, new RegExp(`Pullboard-Item: #${id}\\nPullboard-Rows: C7$`, 'u'));
    assert.equal(box.ref(`refs/pullboard/items/${id}`), box.tips[id], `#${id}'s keep ref names its tip`);
  }
});

test('clause 2: with landing.squash off, the same two items land with --no-ff merge commits [C7,#9219]', async t => {
  const box = landFixture(t);
  const receipt = await landWith(box, false);
  assert.equal(receipt.outcome, 'landed');
  const merges = box.rev('rev-list', '--merges', `${box.base}..refs/heads/main`).split('\n').filter(Boolean);
  assert.equal(merges.length, 2, 'each item is a merge commit');
  assert.equal(box.ref(`refs/pullboard/items/${IDS[0]}`), '', 'no keep ref is written');
  for (const id of IDS) assert.equal(box.rev('merge-base', '--is-ancestor', box.tips[id], 'refs/heads/main') || 'ok', 'ok');
});
