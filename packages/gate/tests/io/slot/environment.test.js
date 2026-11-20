/** withGateSlot admits and runs its action under the env its caller passes, never process.env [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withGateSlot } from '../../../heavy.js';
import { listResources } from '../../../../resources/index.js';
import { fixtureCommittedGraph } from '../../../../store/tests/fixtures/cell.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { executionServices } from '../../fixtures/execution.js';

test('gate.io-slot-environment.withgateslot-holds-its-lease-in-the: withGateSlot holds its lease in the machine home named by its env and runs the action as that env [C7]', async () => {
  const repo = fixtureCommittedGraph('pullboard-gate-env-');
  repo.put('package.json', '{}\n');
  repo.commit();
  const machine = privateFixtureFiles('pullboard-gate-env-machine-').root;
  fixtureMachineSettings(machine, { gateSlots: 1, browserSlots: 1 });
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_AGENT: 'gate-env-agent' };
  const outer = process.env.PULLBOARD_AGENT;
  const seen = await withGateSlot(repo.root, async () => ({
    agent: process.env.PULLBOARD_AGENT,
    holders: listResources({ root: repo.root }).find(row => row.name === 'gate').holders.map(holder => holder.agent),
  }), { env, executionServices, remote: false });
  assert.equal(seen.agent, 'gate-env-agent', 'the action reads the passed env');
  assert.deepEqual(seen.holders, ['gate-env-agent'], 'the lease sits in the passed machine home under the passed agent');
  assert.equal(process.env.PULLBOARD_AGENT, outer, 'process.env is as the caller left it');
});
