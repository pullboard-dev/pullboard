/** @pullboard-test-input source-tree */
/** One hung test file never stops a landing gate: it is red on its own, and every other file still runs [C7,#3167]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../runners/index.js';
import { runFixtureChild } from '../../../apps/cli/tests/fixtures/child.js';
import { completeGate } from '../index.js';
import { landingFailures } from '../index.js';
import { watchdogStoppedOnly } from '../index.js';

const SOURCE = resolve(import.meta.dirname, '../../..');
const PASSING = ['a', 'b', 'd', 'e'];
const FILES = ['a', 'b', 'c', 'd', 'e'].map(name => `test/${name}.test.js`);

/** A private project of five files where test/c.test.js never finishes, landing in the given number of shards. */
function project(t, shards) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-hung-file-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(join(repo, 'test'), { recursive: true });
  mkdirSync(join(home, '.pullboard'), { recursive: true });
  writeFileSync(join(home, '.pullboard', 'settings.json'), JSON.stringify({ gateSlots: 5, browserSlots: 1 }));
  copyPackageFiles(SOURCE, repo);
  // test/e.test.js passes slowly and keeps writing, so it is still running, and never idle, when the hung file times out.
  for (const name of PASSING) {
    writeFileSync(join(repo, `test/${name}.test.js`), `import { test } from 'node:test';\ntest('case ${name} [C7]', ${name === 'e' ? '() => new Promise(done => { const tick = setInterval(() => process.stdout.write("# still running\\n"), 200); setTimeout(() => { clearInterval(tick); done(); }, 6000); })' : '() => {}'});\n`);
  }
  // Busy enough never to look idle, and never done, in file setup where no case runs: an active case keeps its own
  // per-test budget past the wall (250bc82d2c, #2827), so only the whole-file wall can stop a file stuck outside a case.
  writeFileSync(join(repo, 'test/c.test.js'), "setInterval(() => { for (let i = 0; i < 1e6; i += 1); }, 5);\nawait new Promise(() => {});\n");
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node apps/cli/src/io/run/tests.js', landingShards: shards }));
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: join(home, '.pullboard'), GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PULLBOARD_LANDING_RUN: '1', PULLBOARD_TEST_FILE_LIMITS: JSON.stringify({ 'test/c.test.js': 2000 }), PULLBOARD_TEST_IDLE_TIMEOUT_MS: '1000' };
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE_SLOT|BROWSER_SLOT|LANDING_SHARD|LANDING_COLLECT)/u.test(key) || key === 'NODE_TEST_CONTEXT') delete env[key];
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'test: hung-file fixture']]) execFileSync('git', args, { cwd: repo, env });
  return { repo, env };
}

/** Run the landing gate over all five files. */
function gate(box) {
  return runFixtureChild(process.execPath, ['apps/cli/src/io/run/tests.js', ...FILES], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 240_000 });
}

for (const shards of [1, 5]) {
  test(`clause 1: a hung file in a ${shards}-shard landing gate times out alone and every other file runs [C7,#3167]`, t => {
    const run = gate(project(t, shards));
    const output = run.stdout + run.stderr;
    assert.notEqual(run.status, 0, 'the hung file keeps the gate red');
    assert.match(output, /run-tests: TIMEOUT file "?[^\n]*c\.test\.js/u, 'the hung file is recorded as timed out');
    assert.doesNotMatch(output, /Files not run|Landing gate stopped early|stopped by the landing/u, `no file is left unrun: ${output.slice(-3000)}`);
    for (const name of PASSING) assert.match(output, new RegExp(`^ok \\d+ - case ${name} \\[C7\\]`, 'mu'), `test/${name}.test.js ran to completion`);
  });
}

test('clause 2: the timed-out file is a complete, named red, so it is judged against main and the item like any red [C7,#3167]', t => {
  const box = project(t, 1);
  const run = gate(box);
  const output = run.stdout;
  const result = { isGreen: false, output, stages: [{ status: run.status, output }] };
  // Complete means no file was stopped early, interrupted or left not run, so main can be compared for it.
  assert.equal(completeGate(result, { allowCancelled: true }), true, `every file was accounted for: ${output.slice(-2000)}`);
  // The landing's own failure reader names it by file, the input to both the base-main comparison and the item's
  // changed-file check, exactly as it names any other red.
  const failures = landingFailures(output, box.repo);
  assert.deepEqual([...new Set(failures.map(row => row.file))], ['test/c.test.js'], `only the hung file is red: ${JSON.stringify(failures)}`);
  assert.equal(watchdogStoppedOnly('run-tests: TIMEOUT file "test/c.test.js" slowest running case "x": wall'), true);
  assert.equal(watchdogStoppedOnly('run-tests: TIMEOUT file "x"\nLanding gate stopped early after test/a.test.js: a'), false, 'a real first failure still stops the landing');
});
