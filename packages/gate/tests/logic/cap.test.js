/** The two-minute file cap refuses a candidate that pushes a file past it, naming the file and a split seam [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';
import { receiptStore } from '../../src/io/run/receipt.js';
import { receiptFileRuntimes } from '../../src/io/file/cap.js';
import { retainTestValueTimings } from '../../src/io/test/value/timing.js';
import { FILE_RUNTIME_CAP_MS } from '../../src/logic/cap.js';
import { fileRuntimeCapFailure } from '../../src/logic/cap.js';
import { fileRuntimeCapOutput } from '../../src/logic/cap.js';
import { fileRuntimeCapReport } from '../../src/logic/cap.js';
import { splitSeam } from '../../src/logic/cap.js';

const tests = [{ name: 'a', durationMs: 50_000 }, { name: 'b', durationMs: 60_000 }, { name: 'c', durationMs: 70_000 }];

test('clause 1: a candidate that pushes a file past two minutes is refused naming the file and a split seam [C7]', () => {
  const report = fileRuntimeCapReport({ 'test/x.test.js': { durationMs: 180_000, tests } }, { 'test/x.test.js': 60_000 });
  assert.equal(FILE_RUNTIME_CAP_MS, 120_000);
  assert.equal(report.ok, false);
  assert.match(report.refusals[0].message, /^test\/x\.test\.js now takes 180s \(was 60s, \+120s\)/);
  assert.match(report.refusals[0].message, /split seam: cut after test 2 of 3 \("b"\)/);
  assert.match(fileRuntimeCapOutput(report), /^file runtime cap: test\/x\.test\.js/);
});

test('clause 1: a file already over two minutes is listed for a split item, not refused, unless it grows past the cap again [C7]', () => {
  const before = { 'test/slow.test.js': 300_000, 'test/fast.test.js': 5_000 };
  const same = fileRuntimeCapReport({ 'test/slow.test.js': 310_000 }, before);
  assert.equal(same.ok, true);
  assert.deepEqual(same.over, [{ file: 'test/slow.test.js', durationMs: 300_000 }]);
  assert.match(fileRuntimeCapOutput(same), /files over 120s today[^]*test\/slow\.test\.js: 300s/);
  assert.match(fileRuntimeCapFailure('test/slow.test.js', 430_000, 300_000), /\+130s/);
  assert.equal(fileRuntimeCapFailure('test/fast.test.js', 119_000, 5_000), null);
  assert.equal(fileRuntimeCapFailure('test/new.test.js', 500_000, undefined), null);
});

test('clause 1: the split seam falls back to a generic cut without per-test times and rejects bad input [C7]', () => {
  assert.match(splitSeam([]), /top-level describe\/test groups/);
  assert.match(splitSeam(tests), /60s in the first file|110s in the first file/);
  assert.throws(() => fileRuntimeCapFailure('f', Number.NaN, 0), /missing test file runtime/);
  assert.throws(() => fileRuntimeCapFailure('f', 1, 0, [], 0), /positive finite/);
});

const runner = fileURLToPath(new URL('../../src/io/run/tests.js', import.meta.url));

test('clause 1: real file dispatch reads each file\'s last runtime from the receipt history and refuses a candidate that grows past the cap, naming the file and its split seam [C7]', t => {
  const files = privateFixtureFiles('pullboard-runtime-cap-');
  const directory = files.root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runFixtureGit(['-C', directory, 'init', '-q', '-b', 'main']);
  runFixtureGit(['-C', directory, 'config', 'user.name', 'Fixture']);
  runFixtureGit(['-C', directory, 'config', 'user.email', 'fixture@example.test']);
  files.write('pullboard.json', JSON.stringify({ gate: 'true' }));
  files.write('package.json', JSON.stringify({ type: 'module' }));
  const body = name => `import {test} from 'node:test'; test('${name} one [C7]', async()=>{await new Promise(done=>setTimeout(done,700));}); test('${name} two [C7]', async()=>{await new Promise(done=>setTimeout(done,700));});\n`;
  files.write('grew.test.js', body('grew'));
  files.write('steady.test.js', body('steady'));
  runFixtureGit(['-C', directory, 'add', '-A']);
  runFixtureGit(['-C', directory, 'commit', '-qm', 'fixture']);
  // Two receipts hold the files' last runtimes: grew.test.js took 100 ms, steady.test.js was already past the cap at 1300 ms.
  const store = receiptStore(directory);
  assert.ok(store, 'the fixture repository keeps a receipt store');
  assert.ok(retainTestValueTimings(store, '11111111-1111-4111-8111-111111111111', { files: [{ path: 'grew.test.js', durationMs: 100 }, { path: 'steady.test.js', durationMs: 1_300 }] }));
  assert.deepEqual(receiptFileRuntimes(store), { 'grew.test.js': 100, 'steady.test.js': 1_300 });
  const env = Object.assign({}, process.env);
  env.PULLBOARD_MACHINE_HOME = join(directory, 'machine');
  env.PULLBOARD_FILE_RUNTIME_CAP_MS = '1000';
  const run = (...named) => runFixtureChild(process.execPath, [runner, ...named], { cwd: directory, encoding: 'utf8', detached: true, env });
  const refused = run('grew.test.js');
  assert.notEqual(refused.status, 0, 'a file that grew from 100 ms past the cap fails the run');
  assert.match(refused.stderr + refused.stdout, /grew\.test\.js now takes \d+s \(was 1s, \+\d+s\), over the 1s file cap; split seam: cut (?:after test 1 of 2 \("grew one \[C7\]"\)|before the last test \("grew two \[C7\]"\))/u);
  const listed = run('steady.test.js');
  assert.equal(listed.status, 0, listed.stderr + listed.stdout);
  assert.doesNotMatch(listed.stderr + listed.stdout, /file cap/u, 'a file already over the cap that does not grow is only listed, not refused');
});
