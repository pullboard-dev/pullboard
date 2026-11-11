/** @pullboard-test-input apps/cli/tests/fixtures/child.js packages/gate/index.js packages/gate/src/io/run/tests.js packages/kernel/index.js packages/kernel/src/logic/census.js packages/landing/index.js packages/resources/index.js */
/** Actual entry points obey private machine policy before starting any local body [C7,Q1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withMainCheckout } from '../../../../../../packages/landing/index.js';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../../../tests/fixtures/child.js';
import {
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
  BROWSER_SLOT_HELD_ENV,
} from '../../../../../../packages/resources/index.js';

const SOURCE = join(import.meta.dirname, '../../../../../..');

/** A private machine has idle local capacity and no registered runner. */
function privateMachine(t, runnersOnly) {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-no-local-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const machine = join(home, 'machine');
  mkdirSync(machine);
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
    landingShards: 2, gate: { runnersOnly, runnersFirst: false, runnerWaitMs: 100 } }));
  const env = { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_TEST_REUSE: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runner policy fixture', GIT_AUTHOR_EMAIL: 'runner@example.invalid',
    GIT_COMMITTER_NAME: 'Runner policy fixture', GIT_COMMITTER_EMAIL: 'runner@example.invalid' };
  for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV,
    'NODE_TEST_CONTEXT', 'PULLBOARD_LANDING_RUN', 'PULLBOARD_LANDING_SHARD', 'PULLBOARD_RELEASE_EXECUTORS']) delete env[key];
  return { home, env, marker: join(home, 'body-ran') };
}

/** Run the actual committed runner inside its own checkout, never a stand-in runner body. */
async function directRun(t, runnersOnly, landing = false, inheritedLocal = false) {
  const box = privateMachine(t, runnersOnly);
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: SOURCE }).trim();
  return await withMainCheckout(SOURCE, head, async root => {
    // The real landing reader requires this owned fixture's coordinator checkout on main.
    runFixtureGit(['checkout', '-B', 'main'], { cwd: root, env: box.env });
    const file = 'packages/gate/tests/io/run/fixtures/private-no-local-body.test.js';
    assert.equal(existsSync(join(root, file)), false);
    mkdirSync(join(root, 'packages/gate/tests/io/run/fixtures'), { recursive: true });
    writeFileSync(join(root, file), "import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\n"
      + `test('private actual body [C7]', () => writeFileSync(${JSON.stringify(box.marker)}, 'ran'));\n`);
    runFixtureGit(['add', file], { cwd: root, env: box.env });
    runFixtureGit(['commit', '-qm', 'test: private runner policy body [C7]'], { cwd: root, env: box.env });
    if (landing) box.env.PULLBOARD_LANDING_RUN = '1';
    let args = [join(root, 'packages/gate/src/io/run/tests.js'), file];
    if (inheritedLocal) {
      const driver = join(box.home, 'inherited.mjs');
      writeFileSync(driver, `import { takeResource, gateSlotEnvironment } from ${JSON.stringify(pathToFileURL(join(root, 'packages/resources/index.js')).href)};
import { runFixtureChild } from ${JSON.stringify(pathToFileURL(join(root, 'apps/cli/tests/fixtures/child.js')).href)};
const lease = await takeResource({ name: 'gate', scope: 'machine', root: ${JSON.stringify(root)}, capacity: 1, remote: false });
try {
 const result = runFixtureChild(process.execPath, ${JSON.stringify(args)}, { cwd: ${JSON.stringify(root)}, env: { ...process.env, ...gateSlotEnvironment(lease) }, encoding: 'utf8' });
 process.stdout.write(JSON.stringify(result));
} finally { lease.release(); }\n`);
      args = [driver];
    }
    let result = runFixtureChild(process.execPath, args, {
      cwd: root, env: box.env, encoding: 'utf8', timeout: 20_000,
    }); // budget: the private admission cutoff is bounded; an immortal fixture waiter must fail.
    if (inheritedLocal) {
      assert.equal(result.status, 0, result.context ?? result.stderr);
      result = JSON.parse(result.stdout);
    }
    return { result, ran: existsSync(box.marker), body: existsSync(box.marker) ? readFileSync(box.marker, 'utf8') : null };
  });
}

test('direct focused run refuses unavailable runners without a local test body [C7,Q1]', async t => {
  const { result, ran } = await directRun(t, true);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /RUNNER_WAIT_DEADLINE/u);
  assert.match(result.stderr, /no registered runner/u);
  assert.equal(ran, false, 'idle local capacity cannot start the actual test body');
});

test('direct focused opt-out still executes the actual local test body [C7,Q1]', async t => {
  const { result, ran, body } = await directRun(t, false);
  assert.equal(result.status, 0, result.context ?? result.stderr);
  assert.equal(ran, true);
  assert.equal(body, 'ran');
});

test('an actual inherited local lease cannot bypass runner-only admission [C7,Q1]', async t => {
  const { result, ran } = await directRun(t, true, false, true);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /RUNNER_WAIT_DEADLINE/u);
  assert.equal(ran, false);
});

test('direct landing shards refuse unavailable runners without a local shard body [C7,Q1]', async t => {
  const { result, ran } = await directRun(t, true, true);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /RUNNER_WAIT_DEADLINE/u);
  assert.equal(ran, false, 'landing scheduling cannot bypass the same machine policy');
});

for (const args of [[], ['--landing']]) test(`public gate ${args.join(' ')} refuses before its local body [C7,Q1]`, t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node check.cjs', helpers.sandbox(), { withWorktree: false });
  const privateBox = privateMachine(t, true);
  box.env.PULLBOARD_MACHINE_HOME = privateBox.env.PULLBOARD_MACHINE_HOME;
  writeFileSync(join(box.repo, 'check.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(privateBox.marker)}, 'ran');\n`);
  box.git(box.repo, 'add', 'check.cjs');
  box.git(box.repo, 'commit', '-qm', 'test: private gate body [G1]');
  const result = box.run(box.repo, 'gate', ...args, '--json');
  assert.notEqual(result.code, 0, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'RUNNER_WAIT_DEADLINE');
  assert.equal(existsSync(privateBox.marker), false, 'no configured gate body ran locally');
});

test('landing cleanup failure stops named under runner-only and retains opt-out local recovery [C7,Q1]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node packages/gate/src/io/run/tests.js', helpers.sandbox(), { withWorktree: false });
  mkdirSync(join(box.repo, 'bin'));
  mkdirSync(join(box.repo, 'test'));
  mkdirSync(join(box.repo, 'packages/gate/src/io/run'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/gate/src/io/run/tests.js'), "require('node:fs').writeFileSync(process.env.PULLBOARD_PRIVATE_MARKER, 'ran');\n");
  writeFileSync(join(box.repo, 'test/probe.test.js'), '// the local recovery executable records its actual body\n');
  box.git(box.repo, 'add', 'packages/gate/src/io/run/tests.js', 'test/probe.test.js');
  box.git(box.repo, 'commit', '-qm', 'test: actual private shard recovery body [G1]');
  for (const runnersOnly of [false, true]) {
    const privateBox = privateMachine(t, runnersOnly);
    const file = join(privateBox.env.PULLBOARD_MACHINE_HOME, 'settings.json');
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    // Registered capability input belongs only to this private SQLite pool; no real fleet is changed.
    writeFileSync(file, JSON.stringify({ ...settings, runners: [{ host: 'private-lost-runner', slots: 1, browser: 1, gui: true }],
      gate: { ...settings.gate, runnersFirst: true, memoryFloorMB: 0 } }));
    const module = name => JSON.stringify(pathToFileURL(join(SOURCE, name)).href);
    const script = `import { runLandingShards } from ${module('packages/landing/index.js')};
import { parseProcessCensus } from ${module('packages/kernel/src/logic/census.js')};
import { Refused } from ${module('packages/kernel/index.js')};
import { listResources } from ${module('packages/resources/index.js')};
let output = '', calls = 0;
const result = await runLandingShards({ root: ${JSON.stringify(box.repo)}, runner: ${JSON.stringify(join(box.repo, 'packages/gate/src/io/run/tests.js'))},
 files: ['test/probe.test.js'], count: 1, parseProcessCensus, needsBrowser: async () => false,
 remoteRun: async () => { calls++; throw new Refused('RUNNER_CLEANUP_TIMEOUT', 'private runner cleanup was not verified'); },
 write: text => { output += text; } });
process.stdout.write(JSON.stringify({ green: result.isGreen, calls, output, attempts: result.shards[0].attempts,
 holders: listResources({scope:'machine'}).flatMap(row => row.holders) }));`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
      cwd: box.repo, env: { ...privateBox.env, PULLBOARD_PRIVATE_MARKER: privateBox.marker }, encoding: 'utf8', timeout: 20_000,
    }); // budget: one private transport refusal plus bounded local opt-out recovery.
    assert.equal(result.status, 0, result.context ?? result.stderr);
    const measured = JSON.parse(result.stdout);
    assert.equal(measured.calls, 1, 'a real registered-pool reservation reaches the failing transport port');
    assert.match(measured.output, /RUNNER_CLEANUP_TIMEOUT/u);
    assert.equal(measured.green, !runnersOnly);
    assert.equal(existsSync(privateBox.marker), !runnersOnly);
    assert.deepEqual(measured.attempts.map(row => row.host), runnersOnly ? ['private-lost-runner'] : ['private-lost-runner', 'local']);
    assert.equal(measured.holders.length, 0, 'every owned slot drains after either policy outcome');
  }
});


test('runner-only release refuses its captured local placement before acquiring a slot [C7,Q1]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node check.cjs', helpers.sandbox(), { withWorktree: false });
  const privateBox = privateMachine(t, true);
  const module = name => JSON.stringify(pathToFileURL(join(SOURCE, name)).href);
  const script = `import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runGate } from ${module('packages/gate/index.js')};
import { runLandingShards, releaseExecutors, LANDING_COLLECT_ALL_ENV } from ${module('packages/landing/index.js')};
import { RELEASE_EXECUTORS_ENV } from ${module('packages/gate/index.js')};
import { parseProcessCensus } from ${module('packages/kernel/src/logic/census.js')};
import { listResources } from ${module('packages/resources/index.js')};
const release = { version: 1, id: randomUUID(), executors: releaseExecutors() };
assert.ok(release.executors.some(entry => entry.kind === 'local'));
const original = JSON.stringify(release);
const refuses = error => error.code === 'RUNNER_SOURCE' && /required local release executor/u.test(error.message);
await assert.rejects(runGate(${JSON.stringify(box.repo)}, { gate: 'node check.cjs' }, {
 landing: true, collectAll: true, trustStamp: false, releaseRequest: release }), refuses);
process.env[RELEASE_EXECUTORS_ENV] = original;
process.env[LANDING_COLLECT_ALL_ENV] = '1';
await assert.rejects(runLandingShards({ root: ${JSON.stringify(box.repo)}, runner: 'packages/gate/src/io/run/tests.js',
 files: ['test/probe.test.js'], count: 1, parseProcessCensus }), refuses);
assert.equal(JSON.stringify(release), original, 'captured placement remains intact');
assert.equal(listResources({scope:'machine'}).flatMap(row => row.holders).length, 0);
process.stdout.write('both release entry points refused before admission');`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
    cwd: box.repo, env: privateBox.env, encoding: 'utf8', timeout: 20_000,
  }); // budget: both private release refusals occur before resource admission.
  assert.equal(result.status, 0, result.context ?? result.stderr);
  assert.match(result.stdout, /both release entry points refused before admission/u);
});
