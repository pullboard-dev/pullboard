/** @pullboard-test-input apps/cli/pullboard.js apps/runner/src/io/private/check/worker.js packages/gate/src/io/budgets.js packages/gate/src/io/run/tests.js packages/gate/tests/fixtures/budgets.js packages/git/index.js */
/**
 * The gate's digest (V10): what an agent reads of a red run. And submit's own run of the gate (V16):
 * no stamp stands in for it, and the tree must hold still while it runs.
 */
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { repoPath } from '../../../../packages/kernel/light.js';
import assert from 'node:assert/strict';
import {
  runFixtureChild as spawnSync,
  startFixtureChild as spawn,
} from '../../tests/fixtures/child.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { main as cli } from '../../tests/fixtures/native.js';
import {
  digestOf,
  testConcurrency,
} from '../../../../packages/gate/heavy.js';
import {
  createE2eHelpers,
} from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Read the real file bodies' start/finish records to measure overlap without sampling process names. */
function fileOverlap(file) {
  const active = new Map();
  const starts = [];
  let files = 0, browser = 0;
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const event = JSON.parse(line);
    if (event.start) {
      assert.equal(active.has(event.id), false, 'a file begins once');
      active.set(event.id, event.browser);
      starts.push(event.id);
      files = Math.max(files, active.size);
      browser = Math.max(browser, [...active.values()].filter(Boolean).length);
    } else {
      assert.equal(active.delete(event.id), true, 'every finish has a start');
    }
  }
  assert.equal(active.size, 0, 'every selected file finishes');
  return { files, browser, starts };
}

/** Run a node child to completion without blocking this process, so independent cases overlap; same result shape as the sync runner. */
function runAsync(args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (part) => { stdout += part; });
    child.stderr.on('data', (part) => { stderr += part; });
    child.once('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

test('cli.journeys-gate-main.the-landing-gate-bounds-its-own: the landing gate bounds its own concurrency [C7]', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-file-caps-')));
  dirs.push(root);
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), root);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  const config = join(root, 'pullboard.json');
  assert.deepEqual(testConcurrency(root, 7), { files: 7, browser: 2 }, 'the default file budget is the detected core budget');
  const selected = [];
  for (let id = 0; id < 9; id += 1) {
    const browser = id < 4;
    const folder = repoPath(root, browser ? 'test/cockpit' : 'test/ordinary');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `overlap-${id}.test.js`);
    selected.push(file);
    // A file takes a browser lease only by declaring it on its first line, not by its folder.
    writeFileSync(file, `${browser ? '// pullboard: browser\n' : ''}import {appendFileSync} from 'node:fs';
import {test} from 'node:test';
/** Keep controlled work alive briefly so concurrent file bodies leave overlapping records. */
test('cli.journeys-gate-main.record-real-file-id: record real file ${id} [C7]', async () => {
  appendFileSync(process.env.PULLBOARD_CAP_CAPTURE, JSON.stringify({start:true,id:${id},browser:${browser}})+'\\n');
  await new Promise(resolve => setTimeout(resolve, 200)); // budget: controlled fixture work, not a readiness deadline or production wait.
  appendFileSync(process.env.PULLBOARD_CAP_CAPTURE, JSON.stringify({start:false,id:${id}})+'\\n');
});\n`);
  }
  for (const setting of [{ files: 3, browser: 2 }, { files: 2, browser: 1 }]) {
    writeFileSync(config, JSON.stringify({ testConcurrency: setting }));
    assert.deepEqual(testConcurrency(root, 7), setting, 'pullboard.json overrides the shared policy');
    const cases = [
      { name: 'spawnSync explicit large integer', args: ['--test-concurrency=9'], landing: false },
      { name: 'landing default', args: [], landing: true },
      { name: 'landing true override', args: ['--test-concurrency=true'], landing: true },
      { name: 'landing large integer override', args: ['--test-concurrency=9'], landing: true },
      { name: 'landing serial override', args: ['--test-concurrency=false'], landing: true, serial: true },
    ];
    // The cases write their own capture and machine home, so they run side by side; the setting file is fixed for the batch.
    await Promise.all(cases.map(async (example, caseIndex) => {
      const capture = join(root, `overlap-${setting.files}-${caseIndex}.jsonl`);
      const env = { ...process.env, PULLBOARD_CAP_CAPTURE: capture,
        PULLBOARD_MACHINE_HOME: join(root, `machine-${setting.files}-${caseIndex}`) };
      env.PULLBOARD_LANDING_RUN = example.landing ? '1' : '0';
      // process-level: the test runner is its own node entry and reads its own argv and env.
      const result = await runAsync([join(root, 'apps/cli/src/io/run/tests.js'), ...example.args, ...selected], { cwd: root, env });
      assert.equal(result.status, 0, `${example.name}: ${result.stdout}${result.stderr}`);
      const peak = fileOverlap(capture);
      assert.ok(peak.files <= setting.files, `${example.name}: file-body overlap ${peak.files} exceeds ${setting.files}`);
      assert.ok(peak.browser <= setting.browser, `${example.name}: browser-file overlap ${peak.browser} exceeds ${setting.browser}`);
      if (example.serial) assert.equal(peak.files, 1, 'false keeps the native runner serial');
      assert.deepEqual(peak.starts.sort((a, b) => a - b), Array.from({ length: 9 }, (_, id) => id),
        `${example.name}: every selected file runs once`);
      assert.match(result.stdout, /# tests 9\b/u);
      assert.match(result.stdout, /# fail 0\b/u);
    }));
  }
  writeFileSync(config, JSON.stringify({ testConcurrency: { files: 3, browser: 2 } }));
  const refusals = [];
  for (const value of ['4294967296', '9'.repeat(400)]) {
    const capture = join(root, `invalid-concurrency-${value.length}.jsonl`);
    // process-level: the test runner is its own node entry and reads its own argv and env.
    refusals.push(runAsync([join(root, 'apps/cli/src/io/run/tests.js'), `--test-concurrency=${value}`, ...selected], {
      cwd: root, env: { ...process.env, PULLBOARD_LANDING_RUN: '1', PULLBOARD_CAP_CAPTURE: capture,
        PULLBOARD_MACHINE_HOME: join(root, `machine-invalid-${value.length}`) },
    }).then((result) => {
      assert.notEqual(result.status, 0, 'an invalid native concurrency value is refused');
      assert.match(result.stderr, /invalid --test-concurrency value/u);
      assert.equal(existsSync(capture), false, 'invalid concurrency is refused before any file body runs');
    }));
  }
  let isolationCase = 0;
  for (const flag of ['--test-isolation', '--test_isolation', '--experimental-test-isolation',
    '--experimental_test_isolation', '--experimental_test-isolation', '--experimental-test_isolation']) {
    for (const args of [[`${flag}=none`], [flag, 'none']]) {
      const capture = join(root, `isolation-${isolationCase++}.jsonl`);
      // process-level: the test runner is its own node entry and reads its own argv and env.
      refusals.push(runAsync([join(root, 'apps/cli/src/io/run/tests.js'), ...args, selected.at(-1)], {
        cwd: root, env: { ...process.env, PULLBOARD_CAP_CAPTURE: capture,
          PULLBOARD_MACHINE_HOME: join(root, 'machine-isolation') },
      }).then((result) => {
        assert.notEqual(result.status, 0, `${args.join(' ')} must refuse non-isolated test files`);
        assert.match(result.stderr, /bounded browser test files require process isolation/u);
        assert.equal(existsSync(capture), false, 'a refused isolation mode never starts a test-file body');
      }));
    }
  }
  await Promise.all(refusals);
  writeFileSync(config, JSON.stringify({ testConcurrency: { browser: 3 } }));
  assert.throws(() => testConcurrency(root, 7), /browser must be 1 or 2/);
});

test('cli.journeys-gate-main.a-digest-keeps-the-failures-and: a digest keeps the failures and the end within its cap, however long one line is [V10]', async () => {
  const digest = digestOf(`not ok 1 - ${'x'.repeat(3500)}\n${'ok\n'.repeat(50)}# fail 1\nsummary: 1 failed`);
  assert.ok(digest.length <= 3000, `${digest.length} characters`);
  assert.match(digest, /^not ok 1 - x+…\n/);
  assert.match(digest, /# fail 1\nsummary: 1 failed$/);
});

test('cli.journeys-gate-main.a-digest-of-many-failures-stays: a digest of many failures stays within its cap and still ends with the summary [V10]', async () => {
  const failures = Array.from({ length: 200 }, (_, n) => `not ok ${n} - ${'y'.repeat(250)}`).join('\n');
  const digest = digestOf(`${failures}\n# tests 200\n# fail 200`);
  assert.ok(digest.length <= 3000, `${digest.length} characters`);
  assert.match(digest, /^not ok 0 - /);
  assert.match(digest, /# tests 200\n# fail 200$/);
});

test('cli.journeys-gate-main.a-digest-keeps-the-lines-that: a digest keeps the lines that say why a test failed, and skips passing tests however named [V10]', async () => {
  const tap = [
    '# Subtest: a lane cannot commit outside its folders',
    'ok 1 - a lane cannot commit outside its folders',
    '# Subtest: an error in the store is reported',
    'ok 2 - an error in the store is reported',
    '# Subtest: add returns the new number',
    'not ok 3 - add returns the new number',
    '  ---',
    "  location: '/repo/test/store.test.js:12:1'",
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    2 !== 1',
    '  expected: 1',
    '  actual: 2',
    '  ...',
    ...Array.from({ length: 30 }, (_, n) => `ok ${n + 4} - filler ${n}`),
    '# tests 33',
    '# pass 32',
    '# fail 1',
  ].join('\n');
  const digest = digestOf(tap);
  assert.doesNotMatch(digest, /cannot commit|error in the store/, 'passing tests are not failures');
  assert.match(digest, /^not ok 3 - add returns the new number\n/);
  assert.match(digest, /store\.test\.js:12:1/);
  assert.match(digest, / {4}2 !== 1\n {2}expected: 1\n {2}actual: 2/);
  assert.match(digest, /# fail 1$/);
});
