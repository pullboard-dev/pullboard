/** A red landing batch compares all its failing files with main in parallel, so only new reds bisect [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { knownMainAccount } from '../../../../src/io/known/main.js';
import { knownMainFields } from '../../../../src/io/known/main.js';

/** Run git in a fixture repository. */
function git(root, ...args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** A repository with three test files, one commit as the batch's base, and a batch commit that leaves them unchanged. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pb-parallel-known-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.invalid');
  git(root, 'config', 'user.name', 't');
  mkdirSync(join(root, 'test'));
  for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `test/${name}.test.js`), `// ${name}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, base: git(root, 'rev-parse', 'HEAD') };
}

/** A complete red gate whose accounted failures are the named files, one case each. */
function redGate(files) {
  return { isGreen: false, complete: true, profile: { format: 'tap' },
    accounted: files.map(file => ({ file, name: `case in ${file}`, signature: `sig-${file}` })) };
}

/** A comparison port that records each call and answers per file: red on main with the case, or green. */
function port(base, redOnMain, log) {
  return async (_root, profile) => {
    const file = profile.tests[0].file;
    log.push({ file, at: log.length, open: ++port.open });
    await new Promise(resolve => setImmediate(resolve));
    port.open -= 1;
    const red = redOnMain.has(file);
    return { main: base, files: [{ file, result: red ? 'red' : 'green', failures: red ? [{ file, name: `case in ${file}`, signature: `sig-${file}` }] : [] }] };
  };
}
port.open = 0;

test('landing.parallel.a-red-batch-starts-the-base: a red batch starts the base-main comparison of every failing file before any finishes [C7]', async t => {
  const { root, base } = fixture(t), log = [];
  const files = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'];
  port.open = 0;
  await knownMainAccount({ root, batch: { root, base }, compareMainFailures: port(base, new Set(files), log) }, redGate(files));
  assert.deepEqual(log.map(row => row.file).sort(), files, 'every failing file is compared with main, once');
  assert.deepEqual(log.map(row => row.open), [1, 2, 3], 'all three comparisons were in flight together (parallel), none waited for another');
});

test('landing.parallel.a-batch-whose-failures-are-all: a batch whose failures are all main reds lands whole without bisecting [C7]', async t => {
  const { root, base } = fixture(t), log = [];
  const files = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'];
  port.open = 0;
  const gate = redGate(files);
  const account = await knownMainAccount({ root, batch: { root, base }, compareMainFailures: port(base, new Set(files), log) }, gate);
  assert.equal(account.known.length, 3);
  assert.equal(account.remaining.length, 0, 'no failure is new against main, so nothing remains to bisect');
  assert.notEqual(knownMainFields(gate, account).knownMainProof, null, 'the gate carries a known-main proof, so the whole batch lands');
});

test('landing.parallel.a-batch-with-one-failure-new: a batch with one failure new against main bisects on that failure only [C7]', async t => {
  const { root, base } = fixture(t), log = [];
  const files = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'];
  port.open = 0;
  const gate = redGate(files);
  const account = await knownMainAccount({ root, batch: { root, base }, compareMainFailures: port(base, new Set(['test/a.test.js', 'test/c.test.js']), log) }, gate);
  assert.deepEqual(account.known.map(row => row.file).sort(), ['test/a.test.js', 'test/c.test.js']);
  assert.deepEqual(account.remaining.map(row => row.file), ['test/b.test.js'], 'only the new failure is left to bisect on');
  const fields = knownMainFields(gate, account);
  assert.deepEqual(fields.failures.map(row => row.file), ['test/b.test.js']);
  assert.equal(fields.knownMainProof, null);
});
