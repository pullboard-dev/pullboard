/** A census reruns each non-green file once, alone, before reporting it red, behind census.rerunNonGreen, off by default [C7,#9138]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { describeSetting } from '../../../../../packages/config/index.js';
import { runCensus } from '../../../src/io/test/census.js';

const FILES = ['one.test.js', 'two.test.js', 'three.test.js'];

/** A private clean repo tracking three test files, and a machine home with the given settings. */
function fixture(t, settings) {
  const box = privateFixtureFiles('pullboard-census-rerun-');
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

/**
 * A shard dispatcher whose files exit red by `reds(file, call)`, as a shard's log reads, recording each call's files.
 * Call 0 is the census's own job; later calls are reruns.
 */
function dispatcher(reds, calls) {
  return async ({ files, write }) => {
    const call = calls.push([...files]) - 1;
    const red = files.filter(file => reds(file, call));
    write(`# landing shard 1/1 attempt 1 on host-${call}: ${red.length ? 'red' : 'green'} in 9000 ms\n`);
    const lines = files.flatMap(file => [`# landing-file-ms 1500 ${file}`, `# landing-file-exit ${red.includes(file) ? 1 : 0} ${file}`]);
    write(`${lines.join('\n')}\n# tests ${files.length}\n# pass ${files.length - red.length}\n`);
    write('# landing result: done\n');
    return { isGreen: !red.length };
  };
}

const quiet = { err() {}, say() {}, result() {} };

/** The census's JSONL rows by file, failing if any file has more than one row. */
function rowsOf(out) {
  const rows = readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(new Set(rows.map(row => row.file)).size, rows.length, 'one row per file');
  return Object.fromEntries(rows.map(row => [row.file, row]));
}

test('clause 1: with census.rerunNonGreen on, a file red in its job and green alone is reported green with a flaky mark in its row [C7,#9138]', async (t) => {
  const repo = fixture(t, { census: { rerunNonGreen: true } });
  const calls = [], out = join(repo, '..', 'census.jsonl');
  const code = await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run: dispatcher((file, call) => file === 'two.test.js' && call === 0, calls) });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['two.test.js'], 'only the non-green file reruns, alone');
  const rows = rowsOf(out);
  assert.equal(rows['two.test.js'].status, 'green');
  assert.equal(rows['two.test.js'].flaky, true);
  assert.deepEqual(rows['two.test.js'].outcomes.map(outcome => outcome.status), ['red', 'green']);
  assert.equal(rows['one.test.js'].flaky, undefined, 'a file green the first time is not marked');
  assert.equal(code, 0, 'every file reads green');
});

test('clause 2: with census.rerunNonGreen on, a file red twice is reported red with both outcomes in its row [C7,#9138]', async (t) => {
  const repo = fixture(t, { census: { rerunNonGreen: true } });
  const calls = [], out = join(repo, '..', 'census.jsonl');
  const code = await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run: dispatcher(file => file === 'three.test.js', calls) });
  assert.deepEqual(calls.slice(1), [['three.test.js']]);
  const row = rowsOf(out)['three.test.js'];
  assert.equal(row.status, 'red');
  assert.equal(row.flaky, undefined);
  assert.equal(row.outcomes.length, 2);
  assert.deepEqual(row.outcomes.map(outcome => outcome.status), ['red', 'red']);
  assert.deepEqual(row.outcomes.map(outcome => outcome.host), ['host-0', 'host-1'], 'each outcome names the run it came from');
  assert.equal(code, 1);
});

test('clause 3: with census.rerunNonGreen off (the default), rows are exactly as on main, and census.rerunNonGreen is a described setting [C7,#9138]', async (t) => {
  const repo = fixture(t, null);
  const calls = [], out = join(repo, '..', 'census.jsonl');
  await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run: dispatcher(file => file === 'two.test.js', calls) });
  assert.equal(calls.length, 1, 'no file reruns');
  const rows = rowsOf(out);
  assert.deepEqual(Object.keys(rows['two.test.js']).sort(), ['cases', 'file', 'host', 'secs', 'setupSecs', 'sha', 'shard', 'status']);
  assert.equal(rows['two.test.js'].status, 'red');
  const described = describeSetting('census.rerunNonGreen');
  assert.ok(described, 'census.rerunNonGreen has a description');
  assert.equal(described.unit, 'on/off');
});
