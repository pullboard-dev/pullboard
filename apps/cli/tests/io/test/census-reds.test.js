/** A census with reruns on writes its confirmed reds and slow files beside its rows, so the census cycle needs no pass 2 [C7,#10348]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runCensus } from '../../../src/io/test/census.js';

const FILES = ['flaky.test.js', 'green.test.js', 'hung.test.js', 'red.test.js'];
const quiet = { err() {}, say() {}, result() {} };

/** A private clean repo tracking the four test files, and a machine home with the given settings. */
function fixture(t, settings) {
  const box = privateFixtureFiles('pullboard-census-reds-');
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
 * A shard dispatcher, as a shard's log reads: red.test.js fails every run with a named case, flaky.test.js fails only in
 * the census's own job, hung.test.js is stopped by the watchdog every run, and green.test.js passes. A rerun is a call of one file.
 */
function dispatcher(calls) {
  return async ({ files, write, count }) => {
    calls.push([...files]);
    const rerun = count === 1;
    const red = files.filter(file => file === 'red.test.js' || (file === 'flaky.test.js' && !rerun));
    write(`# landing shard 1/1 attempt 1 on host-${calls.length}: ${red.length || files.includes('hung.test.js') ? 'red' : 'green'} in 9000 ms\n`);
    const lines = files.flatMap(file => (file === 'hung.test.js'
      ? [`run-tests: HUNG file ${JSON.stringify(`/runner/checkout/${file}`)} made no progress`]
      : [`# landing-file-ms 1500 ${file}`, `# landing-file-exit ${red.includes(file) ? 1 : 0} ${file}`]));
    const failing = red.includes('red.test.js') ? 'not ok 1 - red case fails\n  ---\n  location: \'red.test.js:2:1\'\n  ...\n' : '';
    write(`${failing}${lines.join('\n')}\n# tests ${files.length}\n# pass ${files.length - red.length}\n`);
    write('# landing result: done\n');
    return { isGreen: !red.length };
  };
}

/** Run a one-shard census over the fixture and return the census JSONL path. */
async function census(t, settings) {
  const repo = fixture(t, settings), calls = [], out = join(repo, '..', 'census.jsonl');
  await runCensus(quiet, { info: { root: repo } }, { out }, { shards: 1, run: dispatcher(calls) });
  return { out, calls };
}

/** A list file's lines. */
const lines = path => readFileSync(path, 'utf8').split('\n').filter(Boolean);

for (const setting of ['rerunNonGreen', 'rerunOnSettle']) {
  test(`clause 1: with census.${setting} on, the census writes <out>.reds.txt (file, a tab, first case) and <out>.slow.txt beside its rows [C7,#10348]`, async (t) => {
    const { out } = await census(t, { census: { [setting]: true } });
    const reds = lines(`${out}.reds.txt`);
    assert.deepEqual(reds.map(line => line.split('\t')[0]), ['red.test.js'], `reds: ${reds.join(' | ')}`);
    assert.equal(reds[0].split('\t').length, 2, 'a red line is the file, a tab and why');
    assert.ok(reds[0].split('\t')[1].length > 0, 'a red line names its first failing case or status');
    assert.deepEqual(lines(`${out}.slow.txt`), ['hung.test.js']);
  });
}

test('clause 2: a file red in its job and green on its rerun is in neither list, and a hung file is in the slow list only [C7,#10348]', async (t) => {
  const { out, calls } = await census(t, { census: { rerunNonGreen: true } });
  assert.ok(calls.some(call => call.length === 1 && call[0] === 'flaky.test.js'), 'the flaky file was rerun alone');
  const rows = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).map(row => [row.file, row]));
  assert.equal(rows['flaky.test.js'].flaky, true);
  const reds = lines(`${out}.reds.txt`).map(line => line.split('\t')[0]), slow = lines(`${out}.slow.txt`);
  assert.ok(!reds.includes('flaky.test.js') && !slow.includes('flaky.test.js'), 'green on rerun is in neither list');
  assert.ok(!reds.includes('green.test.js') && !slow.includes('green.test.js'));
  assert.ok(slow.includes('hung.test.js') && !reds.includes('hung.test.js'), 'hung is slow, not red');
});

test('clause 3: with both rerun settings off, the census writes neither list and its rows are unchanged [C7,#10348]', async (t) => {
  const { out, calls } = await census(t, null);
  assert.equal(calls.length, 1, 'no file reruns');
  assert.equal(existsSync(`${out}.reds.txt`), false);
  assert.equal(existsSync(`${out}.slow.txt`), false);
  const rows = readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(rows.length, FILES.length);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['cases', 'claimedAt', 'endedAt', 'file', 'host', 'load1', 'secs', 'setupSecs', 'sha', 'shard', 'startedAt', 'status']);
});
