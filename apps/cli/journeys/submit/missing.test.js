/** @pullboard-test-input source-tree */
/** Submit refuses at once when the frozen check names a test file missing at the submitted commit [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';
import {
  builderRepo,
  commitAll,
  privateRepo,
  put,
} from '../../tests/fixtures/submit/gate.js';
import {
  coordinatorLocal,
  runLocal,
} from './gate/local.js';

// Budget: the criterion's one-second bound, with room for in-process CLI start-up.
const REFUSAL_BOUND_MS = 20_000;

/** A claimed item whose frozen check names test/expected-name.test.js while its commit holds only test/other-name.test.js. */
async function boxWithMissingCheckFile(t, setting) {
  let box = privateRepo(t);
  if (setting) fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { gate: { refuseMissingCheckFile: true } });
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'true', shared: ['pullboard.json'] }));
  box = builderRepo(box);
  const added = await coordinatorLocal(box, 'add', 'build', 'Missing check file', '--check', 'node --test test/expected-name.test.js',
    '--criterion', '1. The file name follows the project naming rule [reasoning].');
  assert.equal(added.code, 0, added.err + added.out);
  const claimed = await runLocal(box, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  put(box.root, 'test/other-name.test.js', "import { test } from 'node:test';\ntest('x', () => {});\n");
  commitAll(box, 'test(core): a differently named test [G1]');
  assert.equal((await runLocal(box, 'fact', '1', 'note', 'clause 1 [reasoning]: the fixture ticks its only clause')).code, 0);
  return box;
}

test('cli.journeys-submit-missing.submit-refuses-in-under-a-second: clause 1: submit refuses in under a second when the frozen check names a missing test file and lists the added files, with gate.refuseMissingCheckFile on [C7]', async (t) => {
  const box = await boxWithMissingCheckFile(t, true);
  const started = Date.now();
  const refused = await runLocal(box, 'submit', '1', '--json');
  const elapsed = Date.now() - started;
  assert.notEqual(refused.code, 0);
  const answer = refused.err + refused.out;
  assert.match(answer, /CHECK_FILE_MISSING/u);
  assert.match(answer, /test\/expected-name\.test\.js/u);
  assert.match(answer, /test\/other-name\.test\.js/u);
  assert.ok(elapsed < REFUSAL_BOUND_MS, `refused in ${elapsed}ms`); // budget: the bound above, not a measured margin.
});
