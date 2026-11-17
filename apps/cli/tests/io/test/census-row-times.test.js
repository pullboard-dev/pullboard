/** Each census row records its job's claim, start and end times and the runner's load at job start [C7,#9284]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runCensus } from '../../../src/io/test/census.js';

const FILES = ['one.test.js', 'two.test.js'];
const quiet = { err() {}, say() {}, result() {} };

/** A private clean repo tracking two test files. */
function fixture(t) {
  const box = privateFixtureFiles('pullboard-census-times-');
  const repo = join(box.root, 'repo');
  const home = join(box.root, 'machine-home');
  mkdirSync(repo);
  mkdirSync(home);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; rmSync(box.root, { recursive: true, force: true }); });
  for (const file of FILES) box.write(`repo/${file}`, "import { test } from 'node:test';\ntest('x', () => {});\n");
  fixtureCommitAll(repo);
  return repo;
}

/** A dispatcher whose one shard writes the job times a pulled runner reports, when `times` is given. */
const dispatcher = times => async ({ files, write }) => {
  write('# landing shard 1/1 attempt 1 on host-a: green in 9000 ms\n');
  const lines = files.map(file => `# landing-file-ms 1500 ${file}\n# landing-file-exit 0 ${file}`).join('\n');
  write(`${times ? `# census-times ${JSON.stringify(times)}\n` : ''}${lines}\n# tests ${files.length}\n# pass ${files.length}\n`);
  write('# landing result: done\n');
  return { isGreen: true };
};

const rowsOf = out => readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

test('clause 1: every row carries claimedAt, startedAt and endedAt as ISO times for its job [C7,#9284]', async (t) => {
  const repo = fixture(t), out = join(repo, '..', 'census.jsonl');
  const times = { claimedAt: '2026-11-16T10:00:00.000Z', startedAt: '2026-11-16T10:00:05.000Z', endedAt: '2026-11-16T10:03:00.000Z', load1: 4.25 };
  await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run: dispatcher(times) });
  const rows = rowsOf(out);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.claimedAt, times.claimedAt);
    assert.equal(row.startedAt, times.startedAt);
    assert.equal(row.endedAt, times.endedAt);
  }
});

test('clause 1: a job that reports no times still gets ISO claim, start and end times, in order [C7,#9284]', async (t) => {
  const repo = fixture(t), out = join(repo, '..', 'census.jsonl');
  await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run: dispatcher(null) });
  for (const row of rowsOf(out)) {
    for (const key of ['claimedAt', 'startedAt', 'endedAt']) assert.equal(new Date(row[key]).toISOString(), row[key]);
    assert.ok(row.claimedAt <= row.startedAt && row.startedAt <= row.endedAt);
  }
});

test('clause 2: every row carries the runner\'s 1-minute load average at job start [C7,#9284]', async (t) => {
  const repo = fixture(t), out = join(repo, '..', 'census.jsonl');
  await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run: dispatcher({ claimedAt: '2026-11-16T10:00:00.000Z', startedAt: '2026-11-16T10:00:05.000Z', endedAt: '2026-11-16T10:03:00.000Z', load1: 4.25 }) });
  assert.deepEqual(rowsOf(out).map(row => row.load1), [4.25, 4.25]);
  await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run: dispatcher(null) });
  for (const row of rowsOf(out)) assert.ok(Number.isFinite(row.load1) && row.load1 >= 0, 'a local census falls back to this host\'s load');
});
