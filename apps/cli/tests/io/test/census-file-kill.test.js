/** census.fileKillSeconds gives a census job whose files all have short records a tight file kill; unset, every job keeps the 600 s stop [C7,#10350]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { censusFileKillSeconds } from '../../../../../packages/config/index.js';
import { fileLimitEnv } from '../../../src/io/test/file-limit.js';
import { runCensus } from '../../../src/io/test/census.js';
import { shardFileKillMs } from '../../../src/logic/census.js';

const TIMES = { 'a.test.js': 20_000, 'b.test.js': 179_000, 'c.test.js': 180_000 };

test('clause 1: with census.fileKillSeconds at 180, a job whose files all have a record under 180 s carries a 180 s file kill, and a job with an unrecorded file or one recorded at 180 s keeps the 600 s stop [C7,#10350]', () => {
  assert.equal(shardFileKillMs(['a.test.js', 'b.test.js'], TIMES, 180), 180_000);
  assert.equal(shardFileKillMs(['a.test.js', 'c.test.js'], TIMES, 180), null);
  assert.equal(shardFileKillMs(['a.test.js', 'new.test.js'], TIMES, 180), null);
  assert.equal(fileLimitEnv({ fileBudgetMs: 180_000 }).PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS, '180000');
});

test('clause 2: with census.fileKillSeconds unset every job carries no kill of its own, and a file killed under it reads hung in its row [C7,#10350]', async (t) => {
  assert.equal(shardFileKillMs(['a.test.js'], TIMES, null), null);
  const box = privateFixtureFiles('pullboard-census-kill-');
  const repo = join(box.root, 'repo'), home = join(box.root, 'machine-home');
  mkdirSync(repo); mkdirSync(home);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; rmSync(box.root, { recursive: true, force: true }); });
  assert.equal(censusFileKillSeconds(), null);
  fixtureMachineSettings(home, { census: { fileKillSeconds: 180 } });
  assert.equal(censusFileKillSeconds(), 180);
  box.write('repo/one.test.js', "import { test } from 'node:test';\ntest('x', () => {});\n");
  fixtureCommitAll(repo);
  const out = join(box.root, 'census.jsonl');
  const run = async ({ write }) => {
    write('# landing shard 1/1 attempt 1 on host: red in 180000 ms\n');
    write(`run-tests: TIMEOUT file ${JSON.stringify(join(repo, 'one.test.js'))} after 180000 ms\n# landing-file-ms 180000 one.test.js\n`);
    write('# landing result: done\n');
    return { isGreen: true };
  };
  await runCensus({ err() {}, say() {}, result() {} }, { info: { root: repo } }, { out }, { shards: 1, run });
  const { readFileSync } = await import('node:fs');
  const rows = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.find(row => row.file === 'one.test.js').status, 'hung');
});
