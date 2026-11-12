/** Each hot command loads no more modules than its recorded budget; budgets only ratchet down [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import budgets from './closure-budget.json' with { type: 'json' };

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./count.js', import.meta.url));

/** The files a runner machine keeps in its pullboard home: jobs, runtimes and signing keys, and no relay state [#6085]. */
const RUNNER_HOME = ['runner-jobs/job-1.json', 'runner-probes/probe.json', 'runner-runtimes.json', 'runner-signing-0123.pem', 'config.json'];

/** A row named `runner-home <command>` runs its command under a runner-shaped pullboard home [#6085]. */
const RUNNER_ROW = /^runner-home /u;

/**
 * The distinct repo files one cold command loads; refusals count too, since the load is paid before the command decides.
 * With a home of 'plain' or 'runner' the command runs under a fresh pullboard home of that shape instead of this machine's.
 */
function modulesLoaded(args, home = null) {
  const files = privateFixtureFiles('closure-budget-');
  files.write('seen.txt', '');
  const env = Object.fromEntries(Object.entries(process.env));
  if (home) {
    files.write('home/.keep', '');
    for (const file of home === 'runner' ? RUNNER_HOME : []) files.write(`home/${file}`, '{}\n');
    env.PULLBOARD_HOME = `${files.root}/home`;
  }
  env.PULLBOARD_OWN_CLI = '1';
  env.PULLBOARD_RESIDENT = '0';
  env.PULLBOARD_COUNT_FILE = `${files.root}/seen.txt`;
  spawnSync(process.execPath, ['--import', PRELOAD, `${ROOT}apps/cli/pullboard.js`, ...args.split(' ')], { cwd: ROOT, encoding: 'utf8', env });
  return new Set(files.read('seen.txt').toString('utf8').split('\n').filter(Boolean)).size;
}

for (const [command, budget] of Object.entries(budgets)) {
  test(`pullboard ${command} loads at most ${budget} modules; a lower count means lower the budget [C7]`, t => {
    const loaded = RUNNER_ROW.test(command) ? modulesLoaded(command.replace(RUNNER_ROW, ''), 'runner') : modulesLoaded(command);
    assert.ok(loaded <= budget, `pullboard ${command} loaded ${loaded} modules, over its budget of ${budget}: import the defining file or load the heavy package at the call, never raise the budget`);
    if (loaded < budget) t.diagnostic(`pullboard ${command} loaded ${loaded}; lower its budget in closure-budget.json to ${loaded}`);
  });
}

test('a cold whoami under a runner-shaped home loads no more modules than under a plain home: runner state never starts the relay sync [C7,#6085]', () => {
  const plain = modulesLoaded('whoami', 'plain');
  const runner = modulesLoaded('whoami', 'runner');
  assert.ok(runner <= plain, `pullboard whoami loaded ${runner} modules under a runner home and ${plain} under a plain home: keep runner state out of syncMayAct`);
});
