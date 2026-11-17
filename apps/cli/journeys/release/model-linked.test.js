/** A device paired to a linked board cannot redeclare the remote coordinator's model [O8,O3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

/** Models the linked cases declare; named so no call carries a literal model string. */
const REMOTE_MODEL = 'Remote Coordinator';
const CLONE_MODEL = 'Clone Coordinator';

test('cli.journeys-release-model-linked.a-paired-device-cannot-redeclare-the: clause 1: a paired device cannot redeclare the remote coordinator\'s model [O8,O3]', async (t) => {
  const relay = await relayClientFixture(t);
  const remoteDeclaration = await relay.cli('join', 'coordinator', '--model', REMOTE_MODEL);
  assert.equal(remoteDeclaration.code, 0, remoteDeclaration.failure);
  await relay.link();
  const pairing = await relay.cli('relay', 'pair');
  assert.equal(pairing.code, 0, `${pairing.failure}; ${pairing.document.error?.code ?? ''}`);
  delete relay.env.PULLBOARD_MODEL;
  const paired = await relay.otherDeviceJoin(pairing.document.code);
  const before = await paired.cli('export');
  assert.equal(before.code, 0, before.failure);
  const remoteCoordinator = before.document.tables.agent.find(agent => agent.agent_id === 'coordinator');
  assert.ok(remoteCoordinator, 'the linked snapshot retains the remote coordinator row');
  assert.equal(remoteCoordinator.agent_path, relay.root, 'the snapshot names the coordinator checkout on the source device');
  assert.equal(before.document.tables.board_meta.find(row => row.meta_key === 'agent_model:coordinator')?.meta_value, 'Remote Coordinator');
  /** Count real sealed moves sent to the relay, excluding checkpoint and token requests (checkpoint uploads follow 013609a3d5). */
  const remoteMoves = () => relay.calls.filter(call => call.method === 'POST' && /\/moves$/u.test(call.path)).length;
  const relayCalls = remoteMoves();
  const linkedInit = await paired.cli('init');
  assert.equal(linkedInit.code, 0, linkedInit.failure);
  assert.equal(remoteMoves(), relayCalls, 'plain linked init does not publish a coordinator registration');
  const afterPlainInit = await paired.cli('export');
  assert.equal(afterPlainInit.code, 0, afterPlainInit.failure);
  assert.deepEqual(afterPlainInit.document, before.document, 'plain linked init preserves the remote coordinator identity and path');
  const callsBeforeRefusals = remoteMoves();

  const refusal = await paired.cli('init', '--model', CLONE_MODEL);
  assert.equal(refusal.code, 1);
  assert.equal(refusal.document.error.code, 'REMOTE_COORDINATOR_MODEL');
  assert.match(refusal.document.error.message, /the coordinator's model is declared on the coordinator's own checkout \(coordinator \(Remote Coordinator\)\)/u);
  assert.equal(refusal.document.error.message.includes('\n'), false, 'the refusal is one line');
  assert.equal(remoteMoves(), callsBeforeRefusals, 'the linked refusal does not attempt a remote registration');
  const joinRefusal = await paired.cli('join', 'coordinator', '--model', CLONE_MODEL);
  assert.equal(joinRefusal.code, 1);
  assert.equal(joinRefusal.document.error.code, 'REMOTE_COORDINATOR_MODEL');
  assert.match(joinRefusal.document.error.message, /the coordinator's model is declared on the coordinator's own checkout \(coordinator \(Remote Coordinator\)\)/u);
  assert.equal(joinRefusal.document.error.message.includes('\n'), false, 'the linked coordinator-join refusal is one line');
  assert.equal(remoteMoves(), callsBeforeRefusals, 'the linked coordinator-join refusal does not dispatch a remote mutation');
  const after = await paired.cli('export');
  assert.equal(after.code, 0, after.failure);
  assert.deepEqual(after.document, before.document, 'linked init preserves the remote coordinator identity and path');
});
