/**
 * Every pullboard command a test spawns works against a temporary machine home, never the OS account's ~/.pullboard,
 * so a fixture never queues for the real runner pool or browser slots [C7].
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import {
  join,
  resolve,
  sep,
} from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const MACHINE_HOME_MODULE = resolve(import.meta.dirname, '../../../../packages/resources/index.js');
const REAL_MACHINE_HOME = join(userInfo().homedir, '.pullboard');

/** The machine home a pullboard process would use in this environment, read through the production resolver. */
function resolvedMachineHome(env) {
  const script = `import { machineHome } from ${JSON.stringify(MACHINE_HOME_MODULE)}; process.stdout.write(machineHome());`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Whether a path is the real machine home or inside it. */
function insideRealHome(path) {
  return path === REAL_MACHINE_HOME || path.startsWith(REAL_MACHINE_HOME + sep);
}

test('a test that spawns claim and submit on a fixture board uses a temporary machine home and waits on no runner [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  delete sandbox.env.PULLBOARD_MACHINE_HOME;
  delete sandbox.env.PULLBOARD_ACCOUNT_HOME;
  sandbox.env.PULLBOARD_TEST_RUNNER_PID ??= String(process.pid);
  sandbox.env.TMPDIR = sandbox.dir;
  const expected = join(sandbox.dir, `pullboard-test-machine-${sandbox.env.PULLBOARD_TEST_RUNNER_PID}`);
  mkdirSync(expected, { recursive: true });
  writeFileSync(join(expected, 'settings.json'), '{}\n');
  const box = helpers.project('true', sandbox);
  const home = resolvedMachineHome(box.env);
  assert.equal(home, expected, 'all fixture commands resolve the same private fallback settings and resource pool');
  assert.ok(!insideRealHome(home), `fixture commands use ${home}, not ~/.pullboard`);

  assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', 'Isolated work', '--specs', 'G1', '--criterion', 'it is isolated', '--check', 'true')).code, 0);
  const claimed = (await box.runLocal(box.web, 'claim', '1'));
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'isolated.txt'), 'isolated\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): isolated work [G1]');
  const submitted = (await box.runLocal(box.web, 'submit', '1', '--wait', '--no-next'));
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  for (const [name, result] of [['claim', claimed], ['submit', submitted]]) {
    assert.doesNotMatch(result.out + result.err, /runner wait/u, `${name} never waited on a runner`);
  }
});

test('a process in a test run that lost its machine home overrides still never resolves ~/.pullboard [C7]', () => {
  const env = { ...process.env, HOME: join(process.env.TMPDIR ?? '/tmp', 'fixture-home') };
  delete env.PULLBOARD_MACHINE_HOME;
  delete env.PULLBOARD_ACCOUNT_HOME;
  env.PULLBOARD_TEST_RUNNER_PID ??= String(process.pid);
  const home = resolvedMachineHome(env);
  assert.ok(!insideRealHome(home), `a stripped fixture environment resolves ${home}, not ~/.pullboard`);
});
