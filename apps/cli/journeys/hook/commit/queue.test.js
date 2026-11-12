/** A commit-msg hook never queues behind gates: it returns at once and leaves no holder or waiter row in the resources store [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import {
  listResources,
  takeResource,
} from '../../../../../packages/resources/index.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Every holder or waiter entry of every resource in a scope, flattened with its resource name. */
function occupants(scope, root) {
  return listResources({ scope, root }).flatMap(resource => Object.values(resource).filter(Array.isArray).flat()
    .filter(entry => entry && typeof entry === 'object').map(entry => ({ resource: resource.name, agent: entry.agent })));
}

test('clause 1; clause 2: with the machine gate queue full, commit-msg on an item folder returns inside 5 s and leaves no holder or waiter row [C7]', { timeout: 60_000 }, async () => {
  const box = helpers.project();
  const session = 'hook-commit-msg-no-queue';
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Hook queue', '--specs', 'G1').code, 0);
  box.env.CODEX_SESSION_ID = session;
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const gitDir = resolve(box.web, box.git(box.web, 'rev-parse', '--git-dir'));
  const scratch = privateFixtureFiles('commit-msg-no-queue-');
  scratch.write('MSG', 'feat(web): one line [G1]\n');
  const message = join(scratch.root, 'MSG');
  const saved = { ...process.env };
  Object.assign(process.env, { PULLBOARD_MACHINE_HOME: box.env.PULLBOARD_MACHINE_HOME, PULLBOARD_HOME: box.env.PULLBOARD_HOME });
  const holds = [];
  try {
    holds.push(await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: box.repo, repo: box.repo, agent: 'holder' }));
    holds.push(await takeResource({ name: 'checkout-session:' + createHash('sha256').update(gitDir).digest('hex'), capacity: 1, scope: 'repo', root: box.repo, agent: 'holder' }));
    const started = performance.now();
    const ran = box.run(box.web, 'hook', 'commit-msg', message);
    const ms = performance.now() - started;
    assert.equal(ran.code, 0, `${ran.err}${ran.out}`);
    assert.ok(ms < 5000, `commit-msg took ${Math.round(ms)} ms with the gate queue full`); // budget: frozen #3834 clause 1 ceiling, under 5 s.
    for (const scope of ['machine', 'repo']) {
      const strangers = occupants(scope, box.repo).filter(row => row.agent !== 'holder');
      assert.deepEqual(strangers, [], `the hook left a ${scope} holder or waiter row`);
    }
  } finally {
    for (const hold of holds) hold.release();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    delete box.env.CODEX_SESSION_ID;
    rmSync(scratch.root, { recursive: true, force: true });
  }
});
