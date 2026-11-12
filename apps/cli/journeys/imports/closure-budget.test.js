/** Each hot command loads no more modules than its recorded budget; budgets only ratchet down [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import budgets from './closure-budget.json' with { type: 'json' };

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./count.js', import.meta.url));

const e2e = createE2eHelpers();
after(e2e.cleanup);

/**
 * A seeded board with a joined seat holding its one item, so the board is warm and next answers the seat's own work. Commands measure there, never in this checkout:
 * a runner's gate checkout has no shared board, so every command there refused UNMERGED_SCHEMA after a load
 * the real command never pays, and the first command in a fresh board pays the board's creation [#5997].
 */
let seat = null;
before(async () => {
  const box = e2e.project();
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Measure the closure');
  assert.equal(added.code, 0, added.err);
  const claimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  seat = box;
});

/** The distinct repo files one cold command loads in the seeded seat; refusals count too, since the load is paid before the command decides. */
function modulesLoaded(args) {
  const files = privateFixtureFiles('closure-budget-');
  files.write('seen.txt', '');
  const env = { ...seat.env };
  env.PULLBOARD_OWN_CLI = '1';
  env.PULLBOARD_RESIDENT = '0';
  env.PULLBOARD_COUNT_FILE = `${files.root}/seen.txt`;
  spawnSync(process.execPath, ['--import', PRELOAD, `${ROOT}apps/cli/pullboard.js`, ...args.split(' ')], { cwd: seat.web, encoding: 'utf8', env });
  return new Set(files.read('seen.txt').toString('utf8').split('\n').filter(Boolean)).size;
}

for (const [command, budget] of Object.entries(budgets)) {
  test(`pullboard ${command} loads at most ${budget} modules; a lower count means lower the budget [C7]`, t => {
    const loaded = modulesLoaded(command);
    assert.ok(loaded <= budget, `pullboard ${command} loaded ${loaded} modules, over its budget of ${budget}: import the defining file or load the heavy package at the call, never raise the budget`);
    if (loaded < budget) t.diagnostic(`pullboard ${command} loaded ${loaded}; lower its budget in closure-budget.json to ${loaded}`);
  });
}
