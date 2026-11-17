/** @pullboard-test-loads packages/gate/src/io/test/tier/selection.js */
/** A commit's tier snapshot is built once per machine and tier code and read back by later processes [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTierSnapshot } from '../../../../src/io/test/tier/cache.js';
import { writeTierSnapshot } from '../../../../src/io/test/tier/cache.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';

/** Point the machine cache at a private folder for one test and restore the caller's setting after it. */
function privateMachine(t) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  const files = privateFixtureFiles('tier-snapshot-machine-');
  process.env.PULLBOARD_MACHINE_HOME = files.root;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(files.root, { recursive: true, force: true });
  });
  return files.root;
}

/** A fresh instance of the selection module, with an empty in-process memory, as another process would load it. */
async function freshSelection(name) {
  return import(`../../../../src/io/test/tier/selection.js?${name}`);
}

const COMMIT = 'a'.repeat(40), CODE = 'c'.repeat(64);
const SNAPSHOT = { manifest: { version: 1, files: [{ file: 'test/a.test.js', tier: 'T1', packages: ['.'], reasons: [] }] },
  owners: new Map([['src/a.js', 'packages/a']]), packageFiles: new Set(['package.json']), helpers: new Map([['test/helper.js', new Set(['.'])]]) };

test('gate.io-test-tier-cache.a-recorded-tier-snapshot-reads-back: a recorded tier snapshot reads back whole, and a damaged or foreign entry is a miss [C7]', t => {
  const home = privateMachine(t);
  assert.equal(readTierSnapshot(COMMIT, CODE), null);
  writeTierSnapshot(COMMIT, CODE, SNAPSHOT);
  assert.deepEqual(readTierSnapshot(COMMIT, CODE), SNAPSHOT);
  assert.equal(readTierSnapshot('b'.repeat(40), CODE), null, 'another commit has no entry');
  assert.equal(readTierSnapshot(COMMIT, 'd'.repeat(64)), null, 'other tier code has no entry');
  const [code] = readdirSync(join(home, 'tier-snapshots'));
  const file = join(home, 'tier-snapshots', code, `${COMMIT}.v8.gz`);
  writeFileSync(file, 'not a snapshot');
  assert.equal(readTierSnapshot(COMMIT, CODE), null, 'a damaged entry is a miss');
  writeTierSnapshot('not-a-commit', CODE, SNAPSHOT);
  assert.equal(existsSync(join(home, 'tier-snapshots', code, 'not-a-commit.v8.gz')), false);
});

test('gate.io-test-tier-cache.selecttesttiers-selects-the-same-units-from: selectTestTiers selects the same units from cached snapshots as from fresh ones, and a later process reads the cache [C7]', async t => {
  const home = privateMachine(t);
  const root = process.cwd();
  const commit = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
  const base = runFixtureGit(['rev-parse', 'HEAD~1'], { cwd: root });
  const fresh = (await freshSelection('first')).selectTestTiers(root, { base, commit });
  assert.ok(fresh, 'this repository has tiers');
  const [code] = readdirSync(join(home, 'tier-snapshots'));
  for (const sha of [commit, base]) assert.ok(existsSync(join(home, 'tier-snapshots', code, `${sha}.v8.gz`)), `${sha} was recorded`);
  const cached = (await freshSelection('second')).selectTestTiers(root, { base, commit });
  assert.deepEqual(cached, fresh);
  // A later process takes the recorded snapshot, so a recorded change shows in its selection.
  const recorded = readTierSnapshot(commit, code);
  writeTierSnapshot(commit, code, { ...recorded, manifest: { ...recorded.manifest, files: [] } });
  const replayed = (await freshSelection('third')).selectTestTiers(root, { base, commit });
  assert.notDeepEqual(replayed, fresh, 'the third process read the recorded snapshot instead of rebuilding');
});
