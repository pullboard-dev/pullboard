/** @pullboard-test-loads packages/gate/index.js */
/** @pullboard-test-loads apps/cli/src/io/test/census.js */
/** pullboard test --census cuts every tracked test file into a few shards per runner and writes one row per file, from one process [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  censusShardCount,
  finalStatus,
  parseShardHeader,
  shardRows,
} from '../../src/logic/census.js';
import { formatTestOutcomes } from '../../../../packages/gate/index.js';
import { runCensus } from '../../src/io/test/census.js';
import { planLandingShards } from '../../../../packages/landing/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const PASSES = "import { test } from 'node:test';\ntest('passes', () => {});\n";
const FAILS = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('fails here', () => assert.equal(1, 2));\n";

test('a census cuts up to three shards per runner, fewer for a runner with fewer slots, and one with no runner [C7]', () => {
  assert.equal(censusShardCount([]), 1);
  assert.equal(censusShardCount([{ slots: 40 }, { slots: 40 }]), 6);
  assert.equal(censusShardCount([{ slots: 1 }, { slots: 2 }, { slots: 40 }]), 6);
  assert.equal(censusShardCount([{ slots: 40 }], 5), 5);
});

test('a shard attempt header and its last word are read from the landing log [C7]', () => {
  assert.deepEqual(parseShardHeader('# landing shard 2/9 attempt 1 on mini-3: red (x y) in 41200 ms (connect 1 s)'), { label: '2/9', attempt: 1, host: 'mini-3', status: 'red' });
  assert.equal(parseShardHeader('# landing shards: 9 balanced by file count'), null);
  assert.equal(finalStatus('green'), true);
  assert.equal(finalStatus('infrastructure'), false);
});

test('every planned file gets a row: green, red with its failing cases, hung, no result or unrun [C7]', () => {
  const outcomes = [
    { file: 'a.test.js', name: 'one', passed: true, skipped: false },
    { file: 'b.test.js', name: 'bad case', passed: false, skipped: false },
    { file: 'b.test.js', name: 'fine case', passed: true, skipped: false },
  ];
  const output = [
    '# tests 4',
    'run-tests: HUNG file "/work/jobs/x/c.test.js" test "t": no output',
    'not ok 2 - bad case', '  ---', "  location: '/work/jobs/x/b.test.js:3:1'", "  failureType: 'testCodeFailure'", '  ...',
    'not ok 3 - parent only', '  ---', "  location: '/work/jobs/x/a.test.js:1:1'", "  failureType: 'subtestsFailed'", '  ...',
  ].join('\n');
  const base = { files: ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js'], host: 'h', label: '1/2', output, outcomes, times: { 'a.test.js': 1250 } };
  const red = Object.fromEntries(shardRows({ ...base, status: 'red' }, 'abc').map(row => [row.file, row]));
  assert.deepEqual(red['a.test.js'], { file: 'a.test.js', status: 'green', cases: [], secs: 1.3, sha: 'abc', shard: '1/2', host: 'h' });
  assert.deepEqual([red['b.test.js'].status, red['b.test.js'].cases], ['red', ['bad case']]);
  assert.equal(red['c.test.js'].status, 'hung');
  assert.equal(red['d.test.js'].status, 'no-result', 'a file with no row of its own in a red shard is no-result, never green');
  const greenShard = Object.fromEntries(shardRows({ ...base, status: 'green' }, 'abc').map(row => [row.file, row.status]));
  assert.equal(greenShard['d.test.js'], 'green', 'a green shard still vouches for its files');
  const crashed = shardRows({ ...base, output: 'Cannot find module', outcomes: [], status: 'red' }, 'abc');
  assert.ok(crashed.every(row => row.status === 'no-result'), 'a red shard that printed no TAP totals vouches for no file');
  assert.ok(shardRows({ ...base, status: 'infrastructure' }, 'abc').every(row => row.status === 'unrun'));
});

/** A tracked project with three test files, and a stand-in shard dispatcher that answers in the landing log's own words. */
function census(box) {
  mkdirSync(join(box.repo, 'test'));
  for (const [name, text] of [['one', PASSES], ['two', PASSES], ['three', FAILS]]) writeFileSync(join(box.repo, `test/${name}.test.js`), text);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: three files');
  const lines = [];
  const io = { err: line => lines.push(line), say: line => lines.push(line), result: () => {} };
  const dispatcher = (statuses, seen = []) => async ({ root, files, count, write }) => {
    const plan = planLandingShards(files, count, {}, root);
    seen.push(plan.map(shard => shard.files));
    plan.forEach((shard, index) => {
      const label = `${index + 1}/${plan.length}`;
      write(`# landing shard ${label} attempt 1 on fake-host: ${statuses[index] ?? 'green'} in 5 ms\n`);
      const red = shard.files.includes('test/three.test.js');
      const own = shard.files.filter(file => file !== 'test/three.test.js').map(file => ({ file, name: 'passes', passed: true, skipped: false }));
      write((own.length ? formatTestOutcomes('00000000-0000-4000-8000-000000000000', own) : '') + [
        ...shard.files.map(file => `# landing-file-ms 1250 ${file}`),
        ...(red ? ['not ok 1 - fails here [C7]', '  ---', "  location: '/runner/checkout/test/three.test.js:3:1'", "  failureType: 'testCodeFailure'", '  ...'] : []),
        `# tests ${shard.files.length}`,
      ].join('\n') + '\n');
    });
    write('# landing result: done\n');
    return { isGreen: false };
  };
  return { io, lines, dispatcher, ctx: { info: { root: box.repo } } };
}

test('a census writes one row per tracked file from its shards, red cases named, and answers red [C7]', async () => {
  const box = e2e.project('true');
  const { io, lines, dispatcher, ctx } = census(box);
  const out = join(box.dir, 'census.jsonl');
  const seen = [];
  const code = await runCensus(io, ctx, { out }, { shards: 2, run: dispatcher(['green', 'red'], seen) });
  assert.equal(code, 1, 'a red file makes the census red');
  assert.equal(seen.length, 1, 'one dispatch for the whole run');
  assert.deepEqual(seen[0].flat().sort(), ['test/one.test.js', 'test/three.test.js', 'test/two.test.js']);
  const rows = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const by = Object.fromEntries(rows.map(row => [row.file, row]));
  assert.equal(rows.length, 3, 'exactly one row per file');
  assert.deepEqual([by['test/one.test.js'].status, by['test/two.test.js'].status], ['green', 'green']);
  assert.equal(by['test/three.test.js'].status, 'red');
  assert.deepEqual(by['test/three.test.js'].cases, ['fails here [C7]']);
  assert.equal(by['test/one.test.js'].secs, 1.3);
  const head = String(box.git(box.repo, 'rev-parse', 'HEAD')).trim();
  assert.ok(rows.every(row => row.sha === head && row.host === 'fake-host'), 'each row names the commit and the host');
  assert.match(lines.at(-1), /1 red/u);
  assert.equal(process.env.PULLBOARD_LANDING_COLLECT_ALL, undefined, 'the collecting switch does not leak out of the run');
});

test('a shard that never answered leaves its files unrun, never green [C7]', async () => {
  const box = e2e.project('true');
  const { io, dispatcher, ctx } = census(box);
  const out = join(box.dir, 'census.jsonl');
  const code = await runCensus(io, ctx, { out }, { shards: 1, run: dispatcher(['infrastructure']) });
  assert.equal(code, 1);
  const rows = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.status), ['unrun', 'unrun', 'unrun']);
});

test('a census refuses a dirty checkout and prefixes that match no tracked test [C7]', async () => {
  const box = e2e.project('true');
  const { io, dispatcher, ctx } = census(box);
  await assert.rejects(runCensus(io, ctx, { out: join(box.dir, 'x.jsonl') }, { prefixes: ['nowhere/'], run: dispatcher([]) }), /no tracked test files/u);
  writeFileSync(join(box.repo, 'test/one.test.js'), `${PASSES}// edited\n`);
  await assert.rejects(runCensus(io, ctx, { out: join(box.dir, 'x.jsonl') }, { run: dispatcher([]) }), /uncommitted changes/u);
});

test('clause 1: a census file is green only from its own pass record; a red shard file with no row of its own is no-result [C7]', () => {
  const base = { files: ['a.test.js', 'b.test.js'], host: 'h', label: '1/1', output: '# tests 2', times: {} };
  const outcomes = [{ file: 'a.test.js', name: 'one', passed: true, skipped: false }];
  const rows = Object.fromEntries(shardRows({ ...base, status: 'red', outcomes }, 'abc').map(row => [row.file, row.status]));
  assert.deepEqual(rows, { 'a.test.js': 'green', 'b.test.js': 'no-result' });
});
