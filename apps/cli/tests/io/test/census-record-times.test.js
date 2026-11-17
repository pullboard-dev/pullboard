/** A census records its per-file times for the next plan only behind census.recordFileTimes, off by default [C7]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runCensus } from '../../../src/io/test/census.js';
import { readFileTimes } from '../../../../../packages/gate/index.js';
import { writeFileTimes } from '../../../../../packages/gate/index.js';
import { landingBalance } from '../../../../../packages/gate/index.js';
import { planLandingShards } from '../../../../../packages/gate/index.js';

const FILES = ['one.test.js', 'two.test.js', 'three.test.js'];

/** A private clean repo tracking three test files, and a machine home with the given settings. */
function fixture(t, settings) {
  const box = privateFixtureFiles('pullboard-census-times-');
  const repo = join(box.root, 'repo');
  const home = join(box.root, 'machine-home');
  mkdirSync(repo);
  mkdirSync(home);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; rmSync(box.root, { recursive: true, force: true }); });
  if (settings) fixtureMachineSettings(home, settings);
  for (const file of FILES) box.write(`repo/${file}`, "import { test } from 'node:test';\ntest('x', () => {});\n");
  fixtureCommitAll(repo);
  return repo;
}

/** A shard dispatcher that answers with a fixed time and a green exit for each file, as a pulled shard's log reads. */
const dispatcher = () => async ({ write }) => {
  write('# landing shard 1/1 attempt 1 on host: green in 9000 ms\n');
  const lines = FILES.flatMap((file, index) => [`# landing-file-ms ${(index + 1) * 1500} ${file}`, `# landing-file-exit 0 ${file}`]);
  write(`${lines.join('\n')}\n# tests 3\n# pass 3\n`);
  write('# landing result: done\n');
  return { isGreen: true };
};

const quiet = { err() {}, say() {}, result() {} };

test('clause 1: with census.recordFileTimes on, a census records the run\'s per-file ms for every green row that has secs [C7]', async (t) => {
  const repo = fixture(t, { census: { recordFileTimes: true } });
  await runCensus(quiet, { info: { root: repo } }, {}, { shards: 1, run: dispatcher() });
  assert.deepEqual(readFileTimes(repo), { 'one.test.js': 1500, 'two.test.js': 3000, 'three.test.js': 4500 });
});

test('clause 2: a census plan made after a recorded census weighs files by those times and reports history [C7]', async (t) => {
  const repo = fixture(t, { census: { recordFileTimes: true } });
  await runCensus(quiet, { info: { root: repo } }, {}, { shards: 1, run: dispatcher() });
  const times = readFileTimes(repo);
  assert.equal(landingBalance(FILES, times), 'history');
  const plan = planLandingShards(FILES, 2, times, repo);
  assert.deepEqual(plan.map(shard => shard.weight).sort((a, b) => a - b), [1500 + 3000, 4500]);
});

test('clause 3: with census.recordFileTimes off, the default, a census writes no file times [C7]', async (t) => {
  const repo = fixture(t, null);
  await runCensus(quiet, { info: { root: repo } }, {}, { shards: 1, run: dispatcher() });
  assert.deepEqual(readFileTimes(repo), {});
  assert.equal(landingBalance(FILES, readFileTimes(repo)), 'file count');
});

test('clause 1: with census.recordFileTimes on, a census write leaves no entry for a file no longer tracked [C7]', async (t) => {
  const repo = fixture(t, { census: { recordFileTimes: true } });
  writeFileTimes(repo, { 'gone.test.js': 788_000, 'one.test.js': 99_000 });
  await runCensus(quiet, { info: { root: repo } }, {}, { shards: 1, run: dispatcher() });
  assert.deepEqual(readFileTimes(repo), { 'one.test.js': 1500, 'two.test.js': 3000, 'three.test.js': 4500 });
});
