/** @pullboard-test-input packages/git/index.js packages/landing/index.js */
/** A landing whose items already landed pushes nothing, and a dirty landing checkout is reset on each attempt, so its dirt never lands [B35,B3,P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { runLandingJob } from '../../../../../packages/landing/index.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];

/** A bare trunk remote seeded from a developer clone; `item` pushes an accepted item's branch off `base`. */
function trunkRemote(t) {
  const { root } = privateFixtureFiles('pullboard-land-batch-');
  const graph = fixtureCommittedGraph('pullboard-land-batch-dev-');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(graph.root, { recursive: true, force: true }); });
  const dev = graph.root;
  const commit = (file, text, message) => {
    writeFileSync(join(dev, file), text);
    git(dev, ['add', file]);
    git(dev, [...AS, 'commit', '-q', '-m', message]);
    return git(dev, ['rev-parse', 'HEAD']);
  };
  const seed = commit('README.md', 'seed\n', 'chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  const item = (id, base = seed) => {
    git(dev, ['checkout', '-q', '--detach', base]);
    const sha = commit(`item-${id}.txt`, `item ${id}\n`, `feat(core): item ${id} [B3]`);
    git(dev, ['push', '-q', 'origin', `${sha}:refs/heads/item/${id}`]);
    return { id, commit: sha, ref: `refs/heads/item/${id}` };
  };
  const tip = () => git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
  const tree = (path, of = 'main') => {
    try { return git(root, ['--git-dir', remote, 'show', `${of}:${path}`]); } catch { return null; }
  };
  return { root, remote, seed, item, tip, tree, runner: join(root, 'runner') };
}

const payloadOf = (box, items, expect) => ({ remote: box.remote, trunk: 'refs/heads/main', expect, items });
const green = () => ({ ok: true });

test('clause 1: a landing whose every item already landed another way pushes nothing and leaves trunk where it was [B35,B3,P7]', async t => {
  const box = trunkRemote(t);
  const one = box.item(1);
  const first = await runLandingJob(payloadOf(box, [one], box.seed), { workdir: box.runner, checks: green });
  assert.equal(first.outcome, 'landed', JSON.stringify(first));
  const landed = box.tip();
  const again = await runLandingJob(payloadOf(box, [one], landed), { workdir: join(box.root, 'other-runner'), checks: () => assert.fail('nothing is checked') });
  assert.deepEqual([again.outcome, again.landed, again.already, again.trunk], ['landed', [], [1], landed], JSON.stringify(again));
  assert.equal(box.tip(), landed, 'trunk is not moved by an already-landed item');
});

test('a dirty landing checkout is reset to the trunk tip before it merges, and the item lands without the dirt [B35,B3,P7]', async t => {
  const box = trunkRemote(t);
  const first = await runLandingJob(payloadOf(box, [box.item(1)], box.seed), { workdir: box.runner, checks: green });
  assert.equal(first.outcome, 'landed', JSON.stringify(first));
  // A crashed earlier landing left the runner's checkout dirty: a changed tracked file and a stray untracked one.
  writeFileSync(join(box.runner, 'README.md'), 'dirty\n');
  writeFileSync(join(box.runner, 'stray.txt'), 'stray\n');
  const two = box.item(2, first.trunk);
  const seen = [];
  const second = await runLandingJob(payloadOf(box, [two], first.trunk), { workdir: box.runner,
    checks: ({ root }) => { seen.push(existsSync(join(root, 'stray.txt')), git(root, ['status', '--porcelain'])); return { ok: true }; } });
  assert.deepEqual([second.outcome, second.landed], ['landed', [2]], JSON.stringify(second));
  assert.deepEqual(seen, [false, ''], 'the check ran on a clean merged tree');
  assert.equal(box.tree('README.md'), 'seed', 'the dirty tracked change never lands');
  assert.equal(box.tree('stray.txt'), null, 'the stray file never lands');
  assert.equal(box.tree('item-2.txt'), 'item 2', 'the item lands');
});

test('a landing checkout dirty on every attempt still lands each time and never loops [B35,B3,P7]', async t => {
  const box = trunkRemote(t);
  let base = box.seed;
  for (const id of [1, 2, 3]) {
    if (existsSync(join(box.runner, '.git'))) writeFileSync(join(box.runner, 'README.md'), `dirty ${id}\n`);
    const receipt = await runLandingJob(payloadOf(box, [box.item(id, base)], base), { workdir: box.runner, checks: green });
    assert.deepEqual([receipt.outcome, receipt.attempts, receipt.landed], ['landed', 1, [id]], JSON.stringify(receipt));
    base = receipt.trunk;
  }
  assert.equal(box.tree('README.md'), 'seed');
});
