/** A census keeps each shard's results when its `# census-times` line arrives as its own write [C7,#9404]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runCensus } from '../../../src/io/test/census.js';

const FILES = ['green.test.js', 'red.test.js'];
const quiet = { err() {}, say() {}, result() {} };
const TIMES = { claimedAt: '2026-11-16T10:00:00.000Z', startedAt: '2026-11-16T10:00:05.000Z', endedAt: '2026-11-16T10:03:00.000Z', load1: 4.25 };

/** A private clean repo tracking the two test files. */
function fixture(t, settings) {
  const box = privateFixtureFiles('pullboard-census-split-');
  const repo = join(box.root, 'repo'), home = join(box.root, 'machine-home');
  mkdirSync(repo); mkdirSync(home);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; rmSync(box.root, { recursive: true, force: true }); });
  if (settings) fixtureMachineSettings(home, settings);
  for (const file of FILES) box.write(`repo/${file}`, "import { test } from 'node:test';\ntest('x', () => {});\n");
  fixtureCommitAll(repo);
  return repo;
}

/** The body of a red shard: the green file passes in 1.5 s, the red one exits 1 in 2.5 s. */
const body = `# landing-file-ms 1500 green.test.js\n# landing-file-exit 0 green.test.js\n# landing-file-ms 2500 red.test.js\n# landing-file-exit 1 red.test.js\n# tests 2\n# pass 1\n# fail 1\n`;

/** A dispatcher writing the census-times line and the body as two separate writes, as pulledCensus did. */
const split = (header, times) => async ({ write }) => {
  write(header);
  write(`# census-times ${JSON.stringify(times)}\n`);
  write(body);
  write('# landing result: done\n');
  return { isGreen: false };
};

const rowsOf = out => Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).map(row => [row.file, row]));

test('clause 1: a shard whose census-times line is its own write still gets every file\'s verdict and secs from the body [C7,#9404]', async (t) => {
  const repo = fixture(t), out = join(repo, '..', 'census.jsonl');
  await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run: split('# landing shard 1/1 attempt 1 on host-a: red in 9000 ms\n', TIMES) });
  const rows = rowsOf(out);
  assert.equal(rows['green.test.js'].status, 'green');
  assert.equal(rows['red.test.js'].status, 'red');
  assert.equal(rows['green.test.js'].secs, 1.5);
  assert.equal(rows['red.test.js'].secs, 2.5);
});

test('clause 2: the same split shard still puts claimedAt, startedAt, endedAt and load1 on both rows [C7,#9404]', async (t) => {
  const repo = fixture(t), out = join(repo, '..', 'census.jsonl');
  await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run: split('# landing shard 1/1 attempt 1 on host-a: red in 9000 ms\n', TIMES) });
  for (const row of Object.values(rowsOf(out))) {
    for (const key of Object.keys(TIMES)) assert.equal(row[key], TIMES[key]);
  }
});

test('clause 3: a one-file rerun answered in the same two-write shape keeps its verdict, secs and times [C7,#9404]', async (t) => {
  const repo = fixture(t, { census: { rerunOnSettle: true } }), out = join(repo, '..', 'census.jsonl');
  let calls = 0;
  const run = async ({ files, write }) => {
    calls += 1;
    if (calls === 1) return split('# landing shard 1/1 attempt 1 on host-a: red in 9000 ms\n', TIMES)({ write });
    write('# landing shard 1/1 attempt 1 on host-b: green in 1000 ms\n');
    write(`# census-times ${JSON.stringify({ ...TIMES, load1: 1.5 })}\n`);
    write(`# landing-file-ms 900 ${files[0]}\n# landing-file-exit 0 ${files[0]}\n# tests 1\n# pass 1\n`);
    write('# landing result: done\n');
    return { isGreen: true };
  };
  await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run });
  const row = rowsOf(out)['red.test.js'];
  assert.ok(calls >= 2, 'the red file was rerun');
  assert.equal(row.secs, 0.9);
  assert.equal(row.load1, 1.5);
  assert.notEqual(row.status, 'unrun');
});
