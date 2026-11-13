/** @pullboard-test-input packages/git/index.js packages/landing/index.js */
/** A red pair is never bisected on trunk: its green item lands alone, and its red item's landing ends red with trunk untouched [C7,P7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { runLandingJob } from '../../../../../packages/landing/index.js';

const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];

/** A bare trunk remote and two accepted items off its seed: item 1 green, item 2 red under the landing check. */
function redPair(t) {
  const { root } = privateFixtureFiles('pullboard-land-red-');
  const graph = fixtureCommittedGraph('pullboard-land-red-dev-');
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
  const item = (id, text) => {
    git(dev, ['checkout', '-q', '--detach', seed]);
    const sha = commit(`land-${id}.test.js`, text, `feat(web): land ${id} [C7]`);
    git(dev, ['push', '-q', 'origin', `${sha}:refs/heads/item/${id}`]);
    return { id, commit: sha, ref: `refs/heads/item/${id}` };
  };
  return { root, remote, seed, green: item(1, 'PASS\n'), red: item(2, 'RED\n'),
    tip: () => git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']) };
}

/** The landing check: red when any merged item file says RED, naming the file. */
function check({ root, items }) {
  const red = items.filter(id => git(root, ['show', `HEAD:land-${id}.test.js`]) === 'RED');
  return red.length ? { ok: false, detail: `red: ${red.map(id => `land-${id}.test.js`).join(', ')}` } : { ok: true };
}

test('a red pair lands nothing; then its green item lands alone and its red item ends red, never bisected on trunk [C7,P7]', async t => {
  const box = redPair(t);
  const payload = (items, expect) => ({ remote: box.remote, trunk: 'refs/heads/main', expect, items });
  const pair = await runLandingJob(payload([box.green, box.red], box.seed), { workdir: join(box.root, 'r1'), checks: check });
  assert.deepEqual([pair.outcome, pair.landed, pair.attempts], ['red', [], 1], JSON.stringify(pair));
  assert.match(pair.detail, /land-2\.test\.js/u, 'the red names its failing file');
  assert.equal(box.tip(), box.seed, 'a red pair leaves trunk exactly where it was');
  const green = await runLandingJob(payload([box.green], box.seed), { workdir: join(box.root, 'r1'), checks: check });
  assert.deepEqual([green.outcome, green.landed], ['landed', [1]], JSON.stringify(green));
  assert.equal(box.tip(), green.trunk, 'the green item landed on its own check');
  const red = await runLandingJob(payload([box.red], green.trunk), { workdir: join(box.root, 'r2'), checks: check });
  assert.deepEqual([red.outcome, red.landed], ['red', []], JSON.stringify(red));
  assert.equal(box.tip(), green.trunk, 'the red item never reaches trunk');
});
