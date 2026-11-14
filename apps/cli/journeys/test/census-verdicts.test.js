/** @pullboard-test-loads apps/cli/src/io/test/pull.js */
/** @pullboard-test-loads apps/cli/src/logic/census.js */
/** A pulled census shard that is red keeps a per-file verdict for every file, though its framed outcomes and tail are lost [C7,#7920]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { testJobEntry } from '../../src/io/test/pull.js';
import { shardRows } from '../../src/logic/census.js';
import { verdictOutcomes } from '../../src/logic/census.js';

const FILES = ['t/a.test.js', 't/b.test.js', 't/c.test.js'];

/** Run the job entry over a fake red shard whose output is far past the receipt line cap, so its tail and frames are dropped. */
async function redShard(failing = ['not ok 4001 - c.test.js breaks'], at = 't/c.test.js') {
  const box = privateFixtureFiles('pb-census-verdicts-'), dir = box.root;
  box.write('tools/entry.mjs', testJobEntry('# gate receipt ', 'PULLED', 'TIMING_RUN', '# frame ', ''));
  const lines = [];
  for (let n = 0; n < 4000; n += 1) lines.push(`ok ${n + 1} - padding case ${n} ${'x'.repeat(40)}`);
  lines.push(...failing, '  ---', '  duration_ms: 1', `  location: '${join(dir, at)}:1:1'`, '  ...');
  lines.push('# tests 4001', '# fail 1', '# landing-file-ms 10 ./t/a.test.js', '# landing-file-ms 12 t/b.test.js', '# landing-file-ms 30 t/c.test.js');
  box.write('out.txt', lines.join('\n') + '\n');
  const input = { main: 'x', source: 'y', files: FILES, command: `cat ${JSON.stringify(join(dir, 'out.txt'))}; exit 1` };
  return runEntry(box, dir, input);
}

/** Import the job entry in this process, its stdin read from the input and its stdout and exit code captured and restored. */
async function runEntry(box, dir, input) {
  const entry = join(dir, 'tools', 'entry.mjs');
  box.write('tools/entry.mjs', readFileSync(entry, 'utf8').replace("readFileSync(0, 'utf8')", JSON.stringify(JSON.stringify(input))));
  const write = process.stdout.write, argv = process.argv, code = process.exitCode, prior = process.env.PULLBOARD_TEST_PRIOR;
  let stdout = '';
  process.stdout.write = chunk => { stdout += chunk; return true; };
  process.argv = [argv[0], entry, dir];
  try { await import(`${pathToFileURL(entry).href}?run=${Math.random()}`); } finally { process.stdout.write = write; process.argv = argv; process.exitCode = code; if (prior === undefined) delete process.env.PULLBOARD_TEST_PRIOR; }
  const line = stdout.split('\n').find(row => row.startsWith('# gate receipt '));
  assert.ok(line, stdout.slice(-500));
  return JSON.parse(line.slice('# gate receipt '.length));
}

test('clause 1: a red census shard whose output is past the receipt line still records a per-file verdict, green and red, never whole-shard no-result [C7,#7920]', async () => {
  const receipt = await redShard();
  assert.doesNotMatch(receipt.phases[0].tail, /padding case 0 /u, 'the tail is clipped, so the head of the output is not in it');
  assert.equal(receipt.verdicts['t/a.test.js'], 'green');
  assert.equal(receipt.verdicts['t/b.test.js'], 'green');
  assert.deepEqual(receipt.verdicts['t/c.test.js'], ['c.test.js breaks']);
  const outcomes = verdictOutcomes(receipt.verdicts);
  const rows = shardRows({ files: FILES, status: 'red', host: 'r', label: '1/1', output: receipt.phases[0].tail, outcomes, times: {} }, 'sha');
  assert.deepEqual(rows.map(row => [row.file, row.status]), [['t/a.test.js', 'green'], ['t/b.test.js', 'green'], ['t/c.test.js', 'red']]);
});

test('clause 1: a shard with no verdicts reads as before, and verdictOutcomes refuses nothing it cannot name [C7,#7920]', () => {
  assert.equal(verdictOutcomes(null), null);
  assert.equal(verdictOutcomes({}), null);
  assert.deepEqual(verdictOutcomes({ 'a.js': 'green', 'b.js': ['boom'] }).map(row => [row.file, row.passed]), [['a.js', true], ['b.js', false]]);
});

test('clause 1: a failing case is placed by its own location line before its name, so a title naming another file never turns the failing file green [C7,#7920]', async () => {
  const receipt = await redShard(['not ok 4001 - reads the log of ./t/a.test.js']);
  assert.deepEqual(receipt.verdicts['t/c.test.js'], ['reads the log of ./t/a.test.js']);
  assert.equal(receipt.verdicts['t/a.test.js'], 'green');
  assert.equal(receipt.verdicts['t/b.test.js'], 'green');
});
