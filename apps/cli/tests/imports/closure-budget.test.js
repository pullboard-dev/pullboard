/** Each hot command loads no more modules than its recorded budget; budgets only ratchet down [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../fixtures/child.js';
import budgets from './closure-budget.json' with { type: 'json' };

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./count.js', import.meta.url));

/** The distinct repo files one cold command loads; refusals count too, since the load is paid before the command decides. */
function modulesLoaded(args) {
  const files = privateFixtureFiles('closure-budget-');
  files.write('seen.txt', '');
  const env = Object.fromEntries(Object.entries(process.env));
  env.PULLBOARD_OWN_CLI = '1';
  env.PULLBOARD_RESIDENT = '0';
  env.PULLBOARD_COUNT_FILE = `${files.root}/seen.txt`;
  spawnSync(process.execPath, ['--import', PRELOAD, `${ROOT}apps/cli/pullboard.js`, ...args.split(' ')], { cwd: ROOT, encoding: 'utf8', env });
  return new Set(files.read('seen.txt').toString('utf8').split('\n').filter(Boolean)).size;
}

for (const [command, budget] of Object.entries(budgets)) {
  test(`pullboard ${command} loads at most ${budget} modules; a lower count means lower the budget [C7]`, t => {
    const loaded = modulesLoaded(command);
    assert.ok(loaded <= budget, `pullboard ${command} loaded ${loaded} modules, over its budget of ${budget}: import the defining file or load the heavy package at the call, never raise the budget`);
    if (loaded < budget) t.diagnostic(`pullboard ${command} loaded ${loaded}; lower its budget in closure-budget.json to ${loaded}`);
  });
}
