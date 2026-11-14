/** @pullboard-test-loads apps/cli/src/io/test/census.js */
/** @pullboard-test-loads apps/cli/src/io/test/pull.js */
/** pullboard test --no-file-limit lets slow test and census files run to a hard stop and records their seconds; gate jobs keep the per-file budget [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { fileWatchdogLimits } from '../../../../packages/drive/light.js';
import { queueTestRun } from '../../../../packages/drive/index.js';
import { planLandingShards } from '../../../../packages/landing/index.js';
import { gateShardRequest } from '../../src/io/submit/pull.js';
import { runCensus } from '../../src/io/test/census.js';
import { fileBudgetField } from '../../src/io/test/file-limit.js';
import { fileLimitEnv } from '../../src/io/test/file-limit.js';
import { NO_FILE_LIMIT_MS } from '../../src/io/test/file-limit.js';
import { withFileLimit } from '../../src/io/test/file-limit.js';
import { testJobData } from '../../src/io/test/pull.js';
import { testJobEntry } from '../../src/io/test/pull.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { parseCommandArgs } from '../../src/io/cli-main/options.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const SLOW = 'node:test run of a slow file';

test('clause 1: the flag is a declared boolean and a test job carries the hard stop as its file budget [C7]', () => {
  assert.equal(parseCommandArgs(['test', '--no-file-limit', 'a.test.js']).values['no-file-limit'], true);
  assert.deepEqual(fileBudgetField({ 'no-file-limit': true }), { fileBudgetMs: NO_FILE_LIMIT_MS });
  assert.deepEqual(fileBudgetField({}), {});
  const data = testJobData({ main: 'm', commit: 'c', command: 'x', files: ['a'], fileBudgetMs: NO_FILE_LIMIT_MS });
  assert.equal(data.fileBudgetMs, 600_000, SLOW);
});

test('clause 1: the runner turns the job field into the file budget, wall stop and no-limit marker, and idle detection stays [C7]', () => {
  const env = fileLimitEnv({ fileBudgetMs: NO_FILE_LIMIT_MS });
  assert.deepEqual(env, { PULLBOARD_TEST_FILE_BUDGET_MS: '600000', PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: '600000', PULLBOARD_TEST_NO_FILE_LIMIT: '1' });
  const limits = fileWatchdogLimits('slow.test.js', env);
  assert.equal(limits.budgetMs, 600_000, 'the 3-minute kill is lifted to the hard stop');
  assert.equal(limits.wallMs, limits.budgetMs, 'the wall stop is the same hard stop');
  assert.equal(limits.idleMs, fileWatchdogLimits('slow.test.js', {}).idleMs, 'the idle-hang limit is untouched');
  assert.equal(fileWatchdogLimits('slow.test.js', {}).budgetMs, 180_000);
  for (const bad of [0, -1, 600_001, 1.5, '600000', null]) assert.deepEqual(fileLimitEnv({ fileBudgetMs: bad }), {}, `a field of ${bad} is no limit change`);
});

test('clause 1: the test job entry embeds the same conversion, so the runner applies it from the job field [C7]', () => {
  const entry = testJobEntry('R ', 'P', 'T', 'O', '');
  const source = /function fileLimitEnv[\s\S]*?\n\}\n/u.exec(entry)?.[0];
  assert.ok(source, 'the entry carries the function');
  assert.match(entry, /Object\.assign\(env, fileLimitEnv\(input\)\);/u);
  const embedded = new Function(`return ${source}`)();
  assert.deepEqual(embedded({ fileBudgetMs: 600_000 }), fileLimitEnv({ fileBudgetMs: 600_000 }));
  assert.deepEqual(embedded({}), {});
});

test('clause 1: a queued run passes --no-file-limit to its worker, and only when asked [C7]', t => {
  const board = fixtureBoard(t);
  const root = e2e.project('true').repo;
  const seen = [];
  const launch = (_bin, args) => { seen.push(args); return { unref() {} }; };
  const ctx = { info: { commonDir: root, root } };
  queueTestRun(ctx, work => work(board), { agent: 'seat', files: ['a.test.js'], noFileLimit: true }, { launch });
  queueTestRun(ctx, work => work(board), { agent: 'seat', files: ['a.test.js'] }, { launch });
  assert.ok(seen[0].includes('--no-file-limit'));
  assert.ok(!seen[1].includes('--no-file-limit'));
});

test('clause 1: a local run lifts the limit only while it runs and restores the environment [C7]', async () => {
  delete process.env.PULLBOARD_TEST_NO_FILE_LIMIT;
  process.env.PULLBOARD_TEST_FILE_BUDGET_MS = '5000';
  try {
    const during = await withFileLimit({ 'no-file-limit': true }, async () => ({ ...process.env }));
    assert.equal(during.PULLBOARD_TEST_NO_FILE_LIMIT, '1');
    assert.equal(during.PULLBOARD_TEST_FILE_BUDGET_MS, '600000');
    assert.equal(process.env.PULLBOARD_TEST_NO_FILE_LIMIT, undefined);
    assert.equal(process.env.PULLBOARD_TEST_FILE_BUDGET_MS, '5000');
    const plain = await withFileLimit({}, async () => process.env.PULLBOARD_TEST_NO_FILE_LIMIT);
    assert.equal(plain, undefined);
  } finally { delete process.env.PULLBOARD_TEST_FILE_BUDGET_MS; }
});

test('clause 1: a census with --no-file-limit runs under the lifted limit and each row records the file seconds [C7]', async () => {
  const box = e2e.project('true');
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/slow.test.js'), "import { test } from 'node:test';\ntest('slow', () => {});\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: a slow file');
  const lines = [];
  const io = { err: line => lines.push(line), say: line => lines.push(line), result: () => {} };
  const seen = [];
  const dispatcher = async ({ root, files, count, write }) => {
    seen.push(process.env.PULLBOARD_TEST_NO_FILE_LIMIT);
    const plan = planLandingShards(files, count, {}, root);
    write(`# landing shard 1/${plan.length} attempt 1 on fake-host: green in 5 ms\n`);
    write(`# landing-file-ms 240000 test/slow.test.js\n# tests 1\n`);
    write('# landing result: done\n');
    return { isGreen: true };
  };
  for (const flag of [true, false]) {
    const out = join(box.dir, `census-${flag}.jsonl`);
    const code = await runCensus(io, { info: { root: box.repo } }, { out, 'no-file-limit': flag }, { shards: 1, run: dispatcher });
    assert.equal(code, 0);
    const [row] = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(row.secs, 240, 'a 4-minute file is a green row with its seconds');
  }
  assert.deepEqual(seen, ['1', undefined]);
  assert.equal(process.env.PULLBOARD_TEST_NO_FILE_LIMIT, undefined);
});

test('clause 2: gate and landing jobs and plain test jobs keep the per-file budget unchanged [C7]', () => {
  assert.ok(!('fileBudgetMs' in testJobData({ main: 'm', commit: 'c', command: 'x', files: ['a'] })), 'a test job without the flag carries no field');
  const gate = gateShardRequest({ main: 'a'.repeat(40), source: 'b'.repeat(40), shard: { index: 1, of: 1, files: ['a.test.js'], command: 'x' } });
  assert.ok(!JSON.stringify(gate).includes('fileBudgetMs'), 'a gate job request has no file budget field');
  assert.ok(!gate.input.entry.includes('fileLimitEnv') && !gate.input.entry.includes('NO_FILE_LIMIT'), 'the gate entry never reads it');
  assert.deepEqual(fileLimitEnv(gate.input.data), {}, 'even a gate job\'s data lifts nothing');
});
