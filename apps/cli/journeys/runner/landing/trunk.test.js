/** A land job's check sees its admitted trunk: the detached landing checkout carries the runner trunk record run-tests reads [P7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { runLandingJob } from '../../../../../packages/landing/index.js';
import { carriedRunnerTrunk } from '../../../../../packages/sandbox/light.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];

/** A bare trunk remote seeded on main and one accepted item pushed beside it. */
function trunkWithItem(t) {
  const { root } = privateFixtureFiles('pullboard-land-trunk-');
  const graph = fixtureCommittedGraph('pullboard-land-trunk-dev-');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(graph.root, { recursive: true, force: true }); });
  const dev = graph.root;
  const commit = (file, message) => {
    writeFileSync(join(dev, file), `${file}\n`);
    git(dev, ['add', file]);
    git(dev, [...AS, 'commit', '-q', '-m', message]);
    return git(dev, ['rev-parse', 'HEAD']);
  };
  const seed = commit('README.md', 'chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  const item = commit('item-1.txt', 'feat(core): item 1 [P7]');
  git(dev, ['push', '-q', 'origin', `${item}:refs/heads/item/1`]);
  return { seed, remote, workdir: join(root, 'land'), item: { id: 1, commit: item, ref: 'refs/heads/item/1' } };
}

test('clause 1: the landing check runs on a checkout whose carried runner trunk is the payload trunk at the merge base [P7]', async t => {
  const box = trunkWithItem(t);
  const seen = [];
  const checks = ({ root, base }) => {
    // run-tests' test-file budget and committed-policy readers resolve trunk this way; a detached clone without it refused NO_POLICY.
    seen.push({ base, carried: carriedRunnerTrunk(root), head: git(root, ['rev-parse', 'HEAD']) });
    return { ok: false, detail: 'stop before the push' };
  };
  const receipt = await runLandingJob({ remote: box.remote, trunk: 'refs/heads/main', expect: box.seed, items: [box.item] }, { workdir: box.workdir, checks });
  assert.equal(receipt.outcome, 'red');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].carried, { ref: 'refs/heads/main', commit: box.seed }, 'the carried trunk is the base the items merged on');
  assert.notEqual(seen[0].head, box.seed, 'HEAD is the merge, so budget changes compare the items against trunk');
});
