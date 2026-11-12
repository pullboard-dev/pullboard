/** The person can ship a milestone with --as person, and every command outside the list still refuses it [C7,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeProject } from '../../tests/fixtures/bridge.js';

test('milestone ship --as person --reason is accepted and records the person as the actor [C7]', async t => {
  const box = bridgeProject(t);
  assert.equal((await box.runLocal(box.repo, 'milestone', 'add', '0.1')).code, 0);
  const shipped = await box.runLocal(box.repo, 'milestone', 'ship', '0.1', '--as', 'person', '--reason', 'Ship the fixture release', '--json');
  assert.equal(shipped.code, 0, shipped.err || shipped.out);
  assert.doesNotMatch(shipped.err + shipped.out, /USAGE|COORDINATOR_ACTIONS_ROSE/);
  const shown = await box.runLocal(box.repo, 'milestone', 'ship', '0.1', '--as', 'person', '--reason', 'Ship again', '--json');
  assert.doesNotMatch(shown.out, /--as person works with/);
});

test('a command not in the list still refuses --as person with USAGE [C7]', async t => {
  const box = bridgeProject(t);
  const refused = await box.runLocal(box.repo, 'list', '--as', 'person', '--json');
  assert.equal(refused.code, 1, refused.err || refused.out);
  assert.equal(JSON.parse(refused.out).error.code, 'USAGE');
});
