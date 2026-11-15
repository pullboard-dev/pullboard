/** The coordinator declares its model on a local and a linked board [O8,O3]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox } = e2e;

/** Create an empty real Git main checkout for coordinator initialization coverage. */
function coordinatorRepo(box, name) {
  const repo = join(box.dir, name);
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  return repo;
}


/** Read the ordered coordinator events from the fixture's real SQLite board. */
function coordinatorEvents(repo) {
  const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try { return store.events(board).filter(event => event.event_by === 'coordinator'); }
  finally { store.closeBoard(board); }
}

/** Read the coordinator model from the fixture's real SQLite board. */
function coordinatorModel(repo) {
  const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try { return store.agentAt(board, repo)?.agent_model ?? null; }
  finally { store.closeBoard(board); }
}

test('clause 1: the coordinator declares its model [O8,O3]', async (t) => {
  const box = sandbox();
  delete box.env.PULLBOARD_MODEL;

  const flaggedRepo = coordinatorRepo(box, 'init-flag');
  const flaggedInit = await box.inProcess(flaggedRepo, 'init', '--model', 'CLI Coordinator', '--json');
  assert.equal(flaggedInit.code, 0, flaggedInit.err || flaggedInit.out);
  const flaggedWho = await box.inProcess(flaggedRepo, 'whoami', '--json');
  assert.equal(flaggedWho.code, 0, flaggedWho.err || flaggedWho.out);
  const flaggedIdentity = JSON.parse(flaggedWho.out);
  assert.equal(flaggedIdentity.model, 'CLI Coordinator');
  assert.equal(flaggedIdentity.displayName, 'coordinator (CLI Coordinator)');
  const flaggedJoin = coordinatorEvents(flaggedRepo).find(event => event.event_kind === 'join');
  assert.ok(flaggedJoin, 'init records the coordinator registration');
  assert.equal(JSON.parse(flaggedJoin.event_detail).model, 'CLI Coordinator');

  const envRepo = coordinatorRepo(box, 'init-environment');
  box.env.PULLBOARD_MODEL = 'Environment Coordinator';
  const environmentInit = await box.inProcess(envRepo, 'init', '--json');
  assert.equal(environmentInit.code, 0, environmentInit.err || environmentInit.out);
  const environmentWho = await box.inProcess(envRepo, 'whoami', '--json');
  assert.equal(environmentWho.code, 0, environmentWho.err || environmentWho.out);
  const environmentIdentity = JSON.parse(environmentWho.out);
  assert.equal(environmentIdentity.model, 'Environment Coordinator');
  assert.equal(environmentIdentity.displayName, 'coordinator (Environment Coordinator)');
  const environmentJoin = coordinatorEvents(envRepo).find(event => event.event_kind === 'join');
  assert.ok(environmentJoin, 'environment-backed init records the coordinator registration');
  assert.equal(JSON.parse(environmentJoin.event_detail).model, 'Environment Coordinator');

  delete box.env.PULLBOARD_MODEL;
  const unknownRepo = coordinatorRepo(box, 'init-unknown');
  const unknownInit = await box.inProcess(unknownRepo, 'init', '--json');
  assert.equal(unknownInit.code, 0, unknownInit.err || unknownInit.out);
  const unknownWho = await box.inProcess(unknownRepo, 'whoami', '--json');
  assert.equal(unknownWho.code, 0, unknownWho.err || unknownWho.out);
  const unknownIdentity = JSON.parse(unknownWho.out);
  assert.equal(unknownIdentity.model, 'unknown');
  assert.equal(unknownIdentity.displayName, 'coordinator (unknown)');
  assert.equal(coordinatorModel(unknownRepo), null);

  const declaredRepo = coordinatorRepo(box, 'later-declaration');
  const undeclaredInit = await box.inProcess(declaredRepo, 'init');
  assert.equal(undeclaredInit.code, 0, undeclaredInit.err || undeclaredInit.out);
  const declaration = fixtureJoin(box.run, declaredRepo, 'coordinator', '--model', 'Later Coordinator', '--json');
  assert.equal(declaration.code, 0, declaration.err || declaration.out);
  const declaredIdentity = JSON.parse(declaration.out);
  assert.equal(declaredIdentity.model, 'Later Coordinator');
  assert.equal(declaredIdentity.displayName, 'coordinator (Later Coordinator)');
  const move = await box.inProcess(declaredRepo, 'shout', 'all', 'the declared coordinator acts');
  assert.equal(move.code, 0, move.err || move.out);
  const declaredEvents = coordinatorEvents(declaredRepo);
  const modelEvent = declaredEvents.find(event => event.event_kind === 'model');
  const shoutEvent = declaredEvents.find(event => event.event_kind === 'shout');
  assert.ok(modelEvent, 'the later declaration is an ordered model event');
  assert.ok(shoutEvent, 'the coordinator records a later move');
  assert.equal(JSON.parse(modelEvent.event_detail).model, 'Later Coordinator');
  assert.equal(JSON.parse(shoutEvent.event_detail).model, 'Later Coordinator');

  const canonicalRelay = await relayClientFixture(t, { coordinatorModel: null });
  assert.equal(coordinatorModel(canonicalRelay.root), null, 'the canonical coordinator begins unknown');
  await canonicalRelay.link();
  /** Count real sealed model moves, excluding checkpoint and token requests. */
  const sealedMoves = () => canonicalRelay.calls.filter(call => call.method === 'POST' && /\/moves$/u.test(call.path)).length;
  for (const [command, model] of [['join', 'Linked Join Coordinator'], ['init', 'Linked Init Coordinator']]) {
    const movesBefore = sealedMoves();
    const declared = command === 'join'
      ? await canonicalRelay.cli('join', 'coordinator', '--model', model)
      : await canonicalRelay.cli('init', '--model', model);
    assert.equal(declared.code, 0, declared.failure);
    assert.equal(sealedMoves(), movesBefore + 1, `${command}: canonical linked declaration is one sealed move`);
    const registered = coordinatorEvents(canonicalRelay.root).filter(event => event.event_kind === 'model' && JSON.parse(event.event_detail).model === model);
    assert.equal(registered.length, 1, `${command}: the linked declaration records one model event`);
    assert.equal(coordinatorModel(canonicalRelay.root), model, `${command}: the model is persisted on the linked board`);
    const acted = await canonicalRelay.cli('shout', 'all', `${model} acts`);
    assert.equal(acted.code, 0, acted.failure);
    // An export round trip through the relay orders the read after the linked shout reaches the canonical board.
    const exported = await canonicalRelay.cli('export');
    assert.equal(exported.code, 0, exported.failure);
    const latestShout = coordinatorEvents(canonicalRelay.root).filter(event => event.event_kind === 'shout').at(-1);
    assert.equal(JSON.parse(latestShout.event_detail).model, model, `${command}: later linked moves carry the declared model`);
    const canonical = exported.document.tables.agent.find(agent => agent.agent_id === 'coordinator');
    assert.equal(canonical.agent_path, canonicalRelay.root, `${command}: the canonical coordinator retains its own checkout`);
  }
  const relay = await relayClientFixture(t);
  const remoteDeclaration = await relay.cli('join', 'coordinator', '--model', 'Remote Coordinator');
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

  const refusal = await paired.cli('init', '--model', 'Clone Coordinator');
  assert.equal(refusal.code, 1);
  assert.equal(refusal.document.error.code, 'REMOTE_COORDINATOR_MODEL');
  assert.match(refusal.document.error.message, /the coordinator's model is declared on the coordinator's own checkout \(coordinator \(Remote Coordinator\)\)/u);
  assert.equal(refusal.document.error.message.includes('\n'), false, 'the refusal is one line');
  assert.equal(remoteMoves(), callsBeforeRefusals, 'the linked refusal does not attempt a remote registration');
  const joinRefusal = await paired.cli('join', 'coordinator', '--model', 'Clone Coordinator');
  assert.equal(joinRefusal.code, 1);
  assert.equal(joinRefusal.document.error.code, 'REMOTE_COORDINATOR_MODEL');
  assert.match(joinRefusal.document.error.message, /the coordinator's model is declared on the coordinator's own checkout \(coordinator \(Remote Coordinator\)\)/u);
  assert.equal(joinRefusal.document.error.message.includes('\n'), false, 'the linked coordinator-join refusal is one line');
  assert.equal(remoteMoves(), callsBeforeRefusals, 'the linked coordinator-join refusal does not dispatch a remote mutation');
  const after = await paired.cli('export');
  assert.equal(after.code, 0, after.failure);
  assert.deepEqual(after.document, before.document, 'linked init preserves the remote coordinator identity and path');
});
