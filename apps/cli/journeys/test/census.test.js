/** @pullboard-test-loads packages/gate/index.js */
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
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  HOST,
  installSshStandIn,
} from '../../tests/fixtures/runner/ssh.js';

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

test('every planned file gets a row: green, red with its failing cases, hung or unrun [C7]', () => {
  const outcomes = [
    { file: 'a.test.js', name: 'one', passed: true, skipped: false },
    { file: 'b.test.js', name: 'bad case', passed: false, skipped: false },
    { file: 'b.test.js', name: 'fine case', passed: true, skipped: false },
  ];
  const output = [
    'run-tests: HUNG file "/work/jobs/x/c.test.js" test "t": no output',
    'not ok 2 - bad case', '  ---', "  location: '/work/jobs/x/b.test.js:3:1'", "  failureType: 'testCodeFailure'", '  ...',
    'not ok 3 - parent only', '  ---', "  location: '/work/jobs/x/a.test.js:1:1'", "  failureType: 'subtestsFailed'", '  ...',
  ].join('\n');
  const base = { files: ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js'], host: 'h', label: '1/2', output, outcomes, times: { 'a.test.js': 1250 } };
  const red = Object.fromEntries(shardRows({ ...base, status: 'red' }, 'abc').map(row => [row.file, row]));
  assert.deepEqual(red['a.test.js'], { file: 'a.test.js', status: 'green', cases: [], secs: 1.3, sha: 'abc', shard: '1/2', host: 'h' });
  assert.deepEqual([red['b.test.js'].status, red['b.test.js'].cases], ['red', ['bad case']]);
  assert.equal(red['c.test.js'].status, 'hung');
  assert.equal(red['d.test.js'].status, 'green', 'a file with no failing row in a collecting red shard passed');
  assert.equal(red['a.test.js'].status, 'green', 'a parent that failed only through its children is not a case');
  assert.ok(shardRows({ ...base, status: 'infrastructure' }, 'abc').every(row => row.status === 'unrun'));
});

test('pullboard test --census runs every tracked file on the runner in shards and writes one row each [C7]', { timeout: 240_000 }, () => { // budget: two stand-in runner worker runs
  const box = e2e.project('true');
  const bin = join(box.dir, 'runner-bin');
  const worker = join(box.dir, 'runner-worker');
  const home = join(box.dir, 'runner-home');
  const requests = join(box.dir, 'runner-requests.jsonl');
  for (const folder of [bin, worker, home, join(home, '.pullboard')]) mkdirSync(folder, { recursive: true });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests });
  assert.equal(box.run(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '1').code, 0);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '0'], ['gateSlots', '0']]) assert.equal(box.run(box.repo, 'settings', key, value).code, 0);
  mkdirSync(join(box.repo, 'test'));
  for (const [name, text] of [['one', PASSES], ['two', PASSES], ['three', FAILS]]) writeFileSync(join(box.repo, `test/${name}.test.js`), text);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: three files');
  const out = join(box.dir, 'census.jsonl');
  const ran = box.run(box.repo, 'test', '--census', 'test/', '--out', out, '--json');
  assert.equal(ran.code, 1, `a red file makes the census red: ${ran.err}`);
  const rows = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.file).sort(), ['test/one.test.js', 'test/three.test.js', 'test/two.test.js']);
  const by = Object.fromEntries(rows.map(row => [row.file, row]));
  assert.equal(by['test/one.test.js'].status, 'green');
  assert.equal(by['test/two.test.js'].status, 'green');
  assert.equal(by['test/three.test.js'].status, 'red');
  assert.deepEqual(by['test/three.test.js'].cases, ['fails here']);
  assert.ok(rows.every(row => row.sha === String(box.git(box.repo, 'rev-parse', 'HEAD')).trim() && row.host === HOST), 'each row names the commit and the runner');
});
