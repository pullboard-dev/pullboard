/** @pullboard-world-pin: a land job takes sixteen real item branches off a bare trunk remote through the shipped runLandingJob. */
/** A land job takes a sixteen-item batch, isolates the one red item and lands the other fifteen; a colliding sibling alone goes back [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { runLandingJob } from '../../../../../packages/landing/index.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];
const WAITING = 16;

/** A bare trunk remote with a seed commit and a developer clone that pushes item branches to it. */
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
  const item = (id, file = `item-${id}.txt`, text = `item ${id}\n`) => {
    git(dev, ['checkout', '-q', '--detach', seed]);
    const sha = commit(file, text, `feat(core): item ${id} [C7]`);
    git(dev, ['push', '-q', 'origin', `${sha}:refs/heads/item/${id}`]);
    return { id, commit: sha, ref: `refs/heads/item/${id}` };
  };
  const tip = () => git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
  const has = ancestor => { try { git(root, ['--git-dir', remote, 'merge-base', '--is-ancestor', ancestor, tip()]); return true; } catch { return false; } };
  return { root, seed, item, tip, has, runner: name => join(root, 'runners', name) };
}

const payloadOf = (box, items) => ({ remote: join(box.root, 'trunk.git'), trunk: 'refs/heads/main', expect: box.seed, items });

test('clause 1: a sixteen-item land job isolates its one red item, returns it and lands the other fifteen on one trunk move [C7]', async t => {
  const box = trunkRemote(t);
  const items = Array.from({ length: WAITING }, (_, index) => box.item(index + 1));
  const red = 10;
  const checks = [];
  const receipt = await runLandingJob(payloadOf(box, items), { workdir: box.runner('r1'), checks: ({ items: merged }) => {
    checks.push(merged.length);
    return merged.includes(red) ? { ok: false, detail: `item ${red} turns the tree red` } : { ok: true };
  } });
  const rest = items.map(entry => entry.id).filter(id => id !== red);
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.deepEqual(receipt.landed, rest, 'every other item lands in the same job');
  assert.deepEqual(receipt.returned.map(row => [row.id, row.reason]), [[red, 'red']], 'only the culprit goes back to its builder');
  assert.equal(checks[0], WAITING, 'the first check runs the whole batch at once');
  assert.ok(box.has(items[red - 2].commit) && !box.has(items[red - 1].commit), 'the culprit is not on trunk, its neighbour is');
  for (const id of rest) assert.ok(box.has(items[id - 1].commit), `#${id} is on trunk`);
  // Measured on main: the culprit search checks each item once on top of the whole-batch check, so n + 1 checks, not log2(n) [C7].
  assert.ok(checks.length <= WAITING + 1, `isolating one red costs at most ${WAITING + 1} checks: ${checks.length}`);
});

test('clause 2: sibling items editing one file in a sixteen-item land job: the first lands, only the colliding one goes back [C7]', async t => {
  const box = trunkRemote(t);
  const items = Array.from({ length: WAITING - 2 }, (_, index) => box.item(index + 1));
  const first = box.item(WAITING - 1, 'shared.txt', 'first edit\n'), second = box.item(WAITING, 'shared.txt', 'second edit\n');
  const receipt = await runLandingJob(payloadOf(box, [...items, first, second]), { workdir: box.runner('r1'), checks: () => ({ ok: true }) });
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.deepEqual(receipt.returned.map(row => [row.id, row.reason]), [[second.id, 'conflict']]);
  assert.deepEqual(receipt.landed, [...items.map(entry => entry.id), first.id]);
  assert.ok(box.has(first.commit) && !box.has(second.commit));
});
