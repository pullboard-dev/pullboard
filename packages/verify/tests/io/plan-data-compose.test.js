/** @pullboard-world-pin builds isolated real git repositories without importing another cell's test helpers. */
/** Review retry composes the authoritative plan index and test tiers by their registered row identities [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { retryReviewCommit } from '../../index.js';

const INDEX = 'packages/codemap/data/plan/cells.json';
const TIERS = 'packages/gate/data/tests/tiers.json';
const cell = (name, order) => ({ order, name, file: `packages/${name}/index.js` });
const tier = file => ({ file, tier: 'T1', packages: ['packages/verify'], reasons: [`verify: ${file}`] });
const index = cells => JSON.stringify({ version: 1, item: 1473, rfc: 'docs/rfcs/0006-cells.md', cells }, null, 2) + '\n';
const tiers = files => JSON.stringify({ version: 1, files }, null, 2) + '\n';

/** Run git in a fixture repository and fail immediately if fixture setup is invalid. */
function fixtureGit(root, ...args) {
  return runFixtureGit(args, { cwd: root });
}

/** Build two branches from one base; each side changes both manifests. */
function twoBranches(t, files) {
  const fixture = privateFixtureFiles('verify-review-retry-');
  const root = join(fixture.root, 'repo');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  for (const [path, [base]] of Object.entries(files)) {
    fixture.write(`repo/${path}`, base);
  }
  fixtureGit(root, 'init', '-q');
  fixtureGit(root, 'config', 'user.name', 'Verify retry fixture');
  fixtureGit(root, 'config', 'user.email', 'verify@example.invalid');
  fixtureGit(root, 'add', '-A'); fixtureGit(root, 'commit', '-q', '-m', 'base');
  const base = fixtureGit(root, 'rev-parse', 'HEAD').trim();
  const heads = [0, 1].map(side => {
    fixtureGit(root, 'checkout', '-q', '-b', `side${side}`, base);
    for (const [path, sources] of Object.entries(files)) fixture.write(`repo/${path}`, sources[side + 1]);
    fixtureGit(root, 'add', '-A'); fixtureGit(root, 'commit', '-q', '-m', `side${side}`);
    return fixtureGit(root, 'rev-parse', 'HEAD').trim();
  });
  return { root, heads };
}

test('verify.review.retry-manifests.compose: both authoritative manifest schemas compose with stable bytes and each original row in either branch order [C7]', t => {
  const files = {
    [INDEX]: [index([cell('base', 1)]), index([cell('base', 1), cell('alpha', 2)]), index([cell('base', 1), cell('beta', 3)])],
    [TIERS]: [tiers([tier('base.test.js')]), tiers([tier('base.test.js'), tier('alpha.test.js')]), tiers([tier('base.test.js'), tier('beta.test.js')])],
  };
  const { root, heads } = twoBranches(t, files);
  const compositions = [heads, [...heads].reverse()].map(([ours, theirs]) => {
    const review = retryReviewCommit(root, ours, { commit: theirs });
    return Object.fromEntries([INDEX, TIERS].map(path => [path, fixtureGit(root, 'show', `${review}:${path}`)]));
  });
  assert.deepEqual(compositions[0], compositions[1], 'the manifest bytes do not depend on branch order');
  const composedIndex = JSON.parse(compositions[0][INDEX]);
  assert.deepEqual(composedIndex.cells, [cell('base', 1), cell('alpha', 2), cell('beta', 3)]);
  assert.equal(composedIndex.item, 1473, 'the plan index keeps its original top-level schema');
  const composedTiers = JSON.parse(compositions[0][TIERS]);
  assert.deepEqual(composedTiers.files, [tier('alpha.test.js'), tier('base.test.js'), tier('beta.test.js')]);
  assert.equal(composedTiers.version, 1, 'the test tiers keep their original top-level schema');
});

test('verify.review.retry-manifests.shared-row: competing edits to a shared index or test tier row refuse and name that row in either branch order [C7]', t => {
  for (const [path, base, left, right, identity] of [
    [INDEX, index([cell('shared', 1)]), index([{ ...cell('shared', 1), file: 'packages/left/index.js' }]), index([{ ...cell('shared', 1), file: 'packages/right/index.js' }]), 'cells:shared'],
    [TIERS, tiers([tier('shared.test.js')]), tiers([{ ...tier('shared.test.js'), tier: 'T2' }]), tiers([{ ...tier('shared.test.js'), tier: 'T3' }]), 'files:shared.test.js'],
  ]) {
    const { root, heads } = twoBranches(t, { [path]: [base, left, right] });
    for (const [ours, theirs] of [heads, [...heads].reverse()]) {
      assert.throws(() => retryReviewCommit(root, ours, { commit: theirs }), error =>
        error.code === 'MERGE_CONFLICT' && error.message.includes(path) && error.message.includes(identity));
    }
  }
});
