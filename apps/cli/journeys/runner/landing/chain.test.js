/** Chained land jobs: each candidate builds on its parent, drops only a culprit, and pushes after its parent lands [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { planBatches } from '../../../../../packages/landing/index.js';
import { runChainedLandingJob } from '../../../../../packages/landing/index.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];

/** A real bare trunk remote seeded from a developer clone; items are commits off the seed pushed under refs/heads/item/<id>. */
function trunkRemote(t) {
  const { root } = privateFixtureFiles('pullboard-chain-landing-');
  const graph = fixtureCommittedGraph('pullboard-chain-landing-dev-');
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
  const item = id => {
    git(dev, ['checkout', '-q', '--detach', seed]);
    const sha = commit(`item-${id}.txt`, `feat(core): item ${id} [C7]`);
    git(dev, ['push', '-q', 'origin', `${sha}:refs/heads/item/${id}`]);
    return { id, commit: sha, ref: `refs/heads/item/${id}` };
  };
  const bare = args => git(root, ['--git-dir', remote, ...args]);
  const has = commit => { try { bare(['merge-base', '--is-ancestor', commit, 'main']); return true; } catch { return false; } };
  return { root, remote, seed, item, bare, has };
}

test('clause 1: with 3 batches and a red item in batch 2, batches 1 and 3 land in order by 2 compare-and-swap pushes, batch 3 rebuilt on 1 plus 2 minus the culprit, the culprit returned [C7]', async t => {
  const box = trunkRemote(t);
  const entries = new Map([1, 2, 3].map(id => [id, box.item(id)]));
  const { candidates } = planBatches([[1], [2], [3]]);
  // The board's part, in memory: a candidate's job resolves its children's wait for it once its receipt is posted.
  const receipts = new Map();
  const settle = new Map(candidates.map(c => { let resolve; const promise = new Promise(r => { resolve = r; }); return [c.id, { promise, resolve }]; }));
  const order = [];
  // The check: a tree carrying item 2's file is red; the default judge seam names the batch's last item as culprit.
  const checks = ({ root }) => ({ ok: !existsSync(join(root, 'item-2.txt')), detail: 'item 2 breaks the check' });
  const jobs = candidates.map(async candidate => {
    const payload = {
      remote: box.remote, trunk: 'refs/heads/main', expect: box.seed, parent: candidate.parent,
      below: candidate.below.map(id => entries.get(id)), items: candidate.items.map(id => entries.get(id)),
    };
    const receipt = await runChainedLandingJob(payload, { workdir: join(box.root, 'runners', candidate.id), checks, awaitParent: parent => settle.get(parent).promise });
    order.push(candidate.id);
    receipts.set(candidate.id, receipt);
    settle.get(candidate.id).resolve(receipt);
    return receipt;
  });
  const [one, two, three] = await Promise.all(jobs);

  assert.deepEqual([one.outcome, one.landed, one.pushes], ['landed', [1], 1]);
  assert.deepEqual([two.outcome, two.landed, two.pushes, two.returned.map(r => [r.id, r.reason])], ['returned', [], 0, [[2, 'red']]], 'only the culprit is dropped, and it is returned');
  assert.deepEqual([three.outcome, three.landed, three.pushes, three.rebuilt], ['landed', [3], 1, true]);
  assert.equal(one.pushes + two.pushes + three.pushes, 2, 'two compare-and-swap pushes in all');
  assert.deepEqual(order, ['candidate-1', 'candidate-2', 'candidate-3'], 'each candidate finishes only after its parent');
  assert.equal(three.base, one.trunk, 'batch 3 was rebuilt on batch 1 plus batch 2 minus its culprit');
  assert.equal(box.bare(['rev-parse', 'main']), three.trunk);
  assert.deepEqual(box.bare(['rev-list', '--first-parent', 'main']).split('\n'), [three.trunk, one.trunk, box.seed], 'trunk moved seed -> batch 1 -> batch 3');
  assert.deepEqual([box.has(entries.get(1).commit), box.has(entries.get(2).commit), box.has(entries.get(3).commit)], [true, false, true]);
});

test('clause 1: a child whose parent landed the speculated tree keeps its proof and only replays its merges [C7]', async t => {
  const box = trunkRemote(t);
  const entries = new Map([1, 2].map(id => [id, box.item(id)]));
  const { candidates } = planBatches([[1], [2]]);
  let checked = 0;
  const checks = () => { checked++; return { ok: true }; };
  const base = { remote: box.remote, trunk: 'refs/heads/main', expect: box.seed };
  let parentDone;
  const parentPromise = new Promise(resolve => { parentDone = resolve; });
  const child = runChainedLandingJob({ ...base, parent: candidates[1].parent, below: [entries.get(1)], items: [entries.get(2)] },
    { workdir: join(box.root, 'runners', 'b'), checks, awaitParent: () => parentPromise });
  const head = await runChainedLandingJob({ ...base, parent: null, below: [], items: [entries.get(1)] }, { workdir: join(box.root, 'runners', 'a'), checks });
  parentDone(head);
  const second = await child;
  assert.deepEqual([head.outcome, second.outcome, second.rebuilt, second.base, checked], ['landed', 'landed', false, head.trunk, 2]);
});

test('clause 1: a child never pushes when its parent did not land [C7]', async t => {
  const box = trunkRemote(t);
  const two = box.item(2);
  const receipt = await runChainedLandingJob({ remote: box.remote, trunk: 'refs/heads/main', expect: box.seed, parent: 'candidate-1', below: [], items: [two] },
    { workdir: join(box.root, 'runners', 'c'), awaitParent: async () => ({ outcome: 'lease-lost', trunk: null }) });
  assert.deepEqual([receipt.outcome, receipt.pushes], ['parent-failed', 0]);
  assert.equal(box.bare(['rev-parse', 'main']), box.seed, 'trunk did not move');
});
