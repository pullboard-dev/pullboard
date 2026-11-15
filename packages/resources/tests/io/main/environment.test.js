/** takeResource uses the env its caller passes, not process.env, so two callers can hold leases at once [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listResources } from '../../../src/io/main.js';
import { takeResource } from '../../../src/io/main.js';
import { withEnvironment } from '../../../src/io/environment.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

/** A private machine home for one caller. */
function machine() {
  return privateFixtureFiles('pullboard-resource-env-').root;
}

/** The agent names holding the gate in one machine home, read under that home as its own environment. */
function holders(env) {
  return withEnvironment(env, () => listResources({ root: process.cwd() }).find(row => row.name === 'gate')?.holders.map(holder => holder.agent));
}

test('two takeResource calls with their own env hold leases in their own machine homes at once [C7]', async () => {
  const mine = machine();
  const one = { ...process.env, PULLBOARD_MACHINE_HOME: machine(), PULLBOARD_AGENT: 'env-one' };
  const two = { ...process.env, PULLBOARD_MACHINE_HOME: machine(), PULLBOARD_AGENT: 'env-two' };
  const before = { home: process.env.PULLBOARD_MACHINE_HOME, agent: process.env.PULLBOARD_AGENT };
  process.env.PULLBOARD_MACHINE_HOME = mine;
  try {
    const request = env => takeResource({ env, name: 'gate', capacity: 1, root: process.cwd() });
    const [first, second] = await Promise.all([request(one), request(two)]);
    try {
      assert.deepEqual(holders(one), ['env-one'], 'the first env names the first pool and its agent');
      assert.deepEqual(holders(two), ['env-two'], 'the second env names the second pool and its agent');
      assert.equal(holders({ ...process.env }), undefined, 'process.env\'s own pool took neither lease');
    } finally { first.release(); second.release(); }
  } finally {
    process.env.PULLBOARD_MACHINE_HOME = before.home ?? '';
    if (before.home === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
  }
  assert.equal(process.env.PULLBOARD_AGENT, before.agent, 'no call left its env behind');
});
