/** @pullboard-test-input packages/gate/src/io/test/journey-check.js */
/** The journey check runs the mutation seam per covering cell, reports a sample, and retags what loses coverage [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { runJourneyCheck } from '../../../src/io/test/journey-check.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const ROWS = [
  { file: 'packages/a/tests/a.test.js', kind: 'cell unit', specs: ['S1', 'S2', 'S3', 'S4'] },
  ...['1', '2', '3', '4'].map(n => ({ file: `apps/cli/journeys/edges/j${n}.test.js`, kind: 'journey', specs: [`S${n}`], tag: 'delete', tagBecause: 'covered' })),
  { file: 'apps/cli/journeys/edges/keep.test.js', kind: 'journey', specs: ['S1'], tag: 'keep', tagBecause: 'kept' },
];

/** A manifest file in a private folder; the seam fakes the mutation run, so nothing is executed. */
function fixture(t) {
  const files = privateFixtureFiles('pullboard-journey-check-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  files.write('manifest.json', JSON.stringify({ version: 1, files: ROWS }));
  return files;
}

/** A fake mutation runner: the journey named `drop` is the only catcher of one fault. */
function seam(drop) {
  const calls = [];
  const mutate = async (root, cell, options) => {
    calls.push({ cell, ...options });
    const [journey] = options.extra;
    return { faults: [{ caughtBy: ['t.test.js', journey] }, { caughtBy: journey === drop ? [journey] : ['t.test.js'] }] };
  };
  return { mutate, calls };
}

test('gate.io-test-journey-check.the-check-scores-each-delete-tagged: the check scores each delete-tagged journey with and without it and reports the share that holds [C7]', async t => {
  const files = fixture(t);
  const { mutate, calls } = seam('apps/cli/journeys/edges/j2.test.js');
  const reachOf = () => new Map([['packages/a/tests/a.test.js', new Set(['packages/a/src/x.js'])], ['apps/cli/journeys/edges/j1.test.js', new Set(['packages/a/src/x.js'])], ['packages/z/tests/z.test.js', new Set(['packages/z/src/z.js'])]]);
  const result = await runJourneyCheck(['--manifest', 'manifest.json', files.root], { mutate, reachOf });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 4, 'only the delete tags are run, one covering cell each');
  assert.ok(calls.every(call => call.cell === 'packages/a' && call.all === true && call.extra.length === 1));
  assert.deepEqual(calls[0].reach, { 'packages/a/tests/a.test.js': ['packages/a/src/x.js'], 'apps/cli/journeys/edges/j1.test.js': ['packages/a/src/x.js'] }, 'only the cell tests and the journey carry their reach');
  assert.match(result.stdout, /convert {2}apps\/cli\/journeys\/edges\/j2\.test\.js .*packages\/a falls from 2 to 1 of 2/u);
  assert.match(result.stdout, /hold {2}apps\/cli\/journeys\/edges\/j1\.test\.js/u);
  assert.match(result.stdout, /with 2\/2 {2}without 1\/2/u);
  assert.match(result.stdout, /3 of 4 sampled delete tags hold \(75%\); 1 retagged convert, 0 unmeasured, of 4 delete tags/u);
});

test('gate.io-test-journey-check.limit-runs-only-a-sample-of: --limit runs only a sample of the delete tags, spread over the sorted list [C7]', async t => {
  const files = fixture(t);
  const { mutate, calls } = seam('none');
  const result = await runJourneyCheck(['--manifest', 'manifest.json', '--limit', '2', files.root], { mutate, reachOf: () => new Map() });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.extra[0]), ['apps/cli/journeys/edges/j1.test.js', 'apps/cli/journeys/edges/j3.test.js']);
  assert.match(result.stdout, /2 of 2 sampled delete tags hold \(100%\).* of 4 delete tags/u);
});

test('gate.io-test-journey-check.write-retags-the-dropped-journey-in: --write retags the dropped journey in the manifest file and nothing else, and no flag leaves the file alone [C7]', async t => {
  const files = fixture(t);
  const { mutate } = seam('apps/cli/journeys/edges/j2.test.js');
  await runJourneyCheck(['--manifest', 'manifest.json', files.root], { mutate, reachOf: () => new Map() });
  assert.deepEqual(JSON.parse(files.read('manifest.json')).files, ROWS);
  await runJourneyCheck(['--manifest', 'manifest.json', '--write', files.root], { mutate, reachOf: () => new Map() });
  const tags = Object.fromEntries(JSON.parse(files.read('manifest.json')).files.filter(row => row.tag).map(row => [row.file.split('/').pop(), row.tag]));
  assert.deepEqual(tags, { 'j1.test.js': 'delete', 'j2.test.js': 'convert', 'j3.test.js': 'delete', 'j4.test.js': 'delete', 'keep.test.js': 'keep' });
});

test('gate.io-test-journey-check.the-check-refuses-an-unknown-flag: the check refuses an unknown flag and a non-numeric limit with its usage [C7]', async () => {
  const { mutate, calls } = seam('none');
  for (const args of [['--bogus'], ['--limit', 'many'], ['--limit', '0']]) {
    const result = await runJourneyCheck(args, { mutate, reachOf: () => new Map() });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: journey-check/u);
  }
  assert.equal(calls.length, 0);
});

test('gate.io-test-journey-check.only-checks-just-the-delete-tagged: clause 1: --only checks just the delete-tagged journeys under the listed prefixes, and a prefix matching none exits 1 naming it [C7]', async t => {
  const files = fixture(t);
  const { mutate, calls } = seam('none');
  const result = await runJourneyCheck(['--manifest', 'manifest.json', '--only', 'apps/cli/journeys/edges/j2,apps/cli/journeys/edges/j4', files.root], { mutate, reachOf: () => new Map() });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map(call => call.extra[0]), ['apps/cli/journeys/edges/j2.test.js', 'apps/cli/journeys/edges/j4.test.js']);
  assert.match(result.stdout, /2 of 2 sampled delete tags hold .* of 4 delete tags/u);
  const none = await runJourneyCheck(['--manifest', 'manifest.json', '--only', 'apps/cli/journeys/edges/j1,apps/nowhere/', files.root], { mutate, reachOf: () => new Map() });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /apps\/nowhere\/.*next:/u);
  const keep = await runJourneyCheck(['--manifest', 'manifest.json', '--only', 'apps/cli/journeys/edges/keep', files.root], { mutate, reachOf: () => new Map() });
  assert.equal(keep.status, 1, 'a kept journey is not a delete tag');
  const bare = await runJourneyCheck(['--only'], { mutate, reachOf: () => new Map() });
  assert.equal(bare.status, 1);
});

test('gate.io-test-journey-check.without-only-the-check-samples-the: clause 2: without --only the check samples the same journeys as before, and the usage line lists --only [C7]', async t => {
  const files = fixture(t);
  const { mutate, calls } = seam('none');
  await runJourneyCheck(['--manifest', 'manifest.json', '--limit', '2', files.root], { mutate, reachOf: () => new Map() });
  assert.deepEqual(calls.map(call => call.extra[0]), ['apps/cli/journeys/edges/j1.test.js', 'apps/cli/journeys/edges/j3.test.js']);
  const refused = await runJourneyCheck(['--bogus'], { mutate, reachOf: () => new Map() });
  assert.match(refused.stderr, /\[--only prefix,prefix\]/u);
});
