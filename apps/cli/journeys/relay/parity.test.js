/** @pullboard-test-input apps/relay/src/logic/browser/pages.js packages/pages/src/logic/relay/presentation.js */
import { browserModules } from '../../../relay/index.js';
import { presentationShout } from '../../../../packages/pages/light.js';
import { presentationShout as nodePresentationShout } from '../../../../packages/pages/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { fileURLToPath } from 'node:url';
/** Native API and actual sealed relay readers must expose the same board [H5,H15,H16,A2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parityRoundtrip,
  assertReaderParity,
} from '../../tests/fixtures/relay/parity.js';

test('a field that differs between native and relay readers is refused, naming the field [H5,H16,A2]', { timeout: 60_000 }, async t => { // budget: criterion's sixty-second guard ceiling, including real local HTTP and cleanup.
  const { native, relay, exerciseOperations } = await parityRoundtrip(t);
  const live = native.agents.find(agent => agent.heartbeatAt !== null);
  assert.ok(live, 'a real native heartbeat is present in the seed');
  const missingHeartbeat = structuredClone(native);
  delete missingHeartbeat.agents.find(agent => agent.agent_id === live.agent_id).heartbeatAt;
  assert.throws(() => assertReaderParity(native, missingHeartbeat), error => /agents\.\d+\.heartbeatAt/u.test(error.message)
    && error.message.includes('native=') && error.message.includes('relay=<missing>'), 'the deliberate heartbeat removal names its exact field and both values');
  assertReaderParity(native, relay);
  const inventory = await exerciseOperations();
  assert.deepEqual(inventory.covered, inventory.declared, 'every declared operation passes complete reader parity');
});


test('single-board parity never seals another board title through a milestone reference [H5,H16,A2]', { timeout: 60_000 }, async t => { // budget: the same real transport and cleanup ceiling as the parity guard.
  const { native, relay } = await parityRoundtrip(t, { foreign: true });
  assertReaderParity(native, relay);
});

test('local relay health and its Needs stay outside sealed state without hiding other differences [H5,H16,A2]', { timeout: 60_000 }, async t => { // budget: real local HTTP, sealed snapshot retrieval and cleanup under the guard ceiling.
  const { native, relay, restored } = await parityRoundtrip(t, { localHealth: true });
  assert.equal(native.relayHealthAlerts.length, 1, 'actual private canary failures remain visible locally');
  assert.ok(native.needs.some(entry => entry.kind === 'relay-health'), 'local Needs retains the derived alert');
  assert.equal(Object.hasOwn(restored.presentation.state, 'relayHealthAlerts'), false, 'sealed state omits the private telemetry field');
  assert.ok(!restored.presentation.state.needs.some(entry => entry.kind === 'relay-health'), 'sealed Needs omits the private alert');
  assertReaderParity(native, relay);
  assert.throws(() => assertReaderParity(native, { ...relay, needs: [...relay.needs, { kind: 'undeclared-difference' }] }),
    /reader parity needs/u, 'other Needs differences remain refused');
});


test('relay pages and presentation browser entries reach no Node built-ins [C7,H5,H15]', () => {
  const modules = browserModules(fileURLToPath(new URL('../../../..', import.meta.url)), { named: {
    '/relay/pages.js': 'apps/relay/src/logic/browser/pages.js',
    '/relay/presentation.js': 'packages/pages/src/logic/relay/presentation.js',
  } });
  assert.ok(modules.has('/relay/m/packages/pages/light.js'));
  assert.ok(![...modules.keys()].some(path => path.includes('/shell/')));
  const imports = importsIn([...modules.values()]);
  assert.equal(imports.flat().filter(name => name.startsWith('node:')).length, 0);
  assert.equal(presentationShout, nodePresentationShout, 'both front doors preserve the same pure reader binding');
  const question = { shout_id: 1, shout_decision: true };
  const answer = { shout_id: 2, shout_answers: 1 };
  assert.deepEqual(presentationShout({ shouts: [question, answer] }, 1), {
    ...question, decision_state: 'answered', decision_answer: answer,
  });
  assert.throws(() => presentationShout({}, 1), error => error.code === 'SHOUT_NOT_AVAILABLE');
  assert.throws(() => presentationShout({ shouts: [] }, 1), error => error.code === 'NO_SHOUT');
});
