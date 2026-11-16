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

const FLAG_MODEL = 'CLI Coordinator';
const ENV_MODEL = 'Environment Coordinator';
const LATER_MODEL = 'Later Coordinator';

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
  const flaggedInit = await box.inProcess(flaggedRepo, 'init', '--model', FLAG_MODEL, '--json');
  assert.equal(flaggedInit.code, 0, flaggedInit.err || flaggedInit.out);
  const flaggedWho = await box.inProcess(flaggedRepo, 'whoami', '--json');
  assert.equal(flaggedWho.code, 0, flaggedWho.err || flaggedWho.out);
  const flaggedIdentity = JSON.parse(flaggedWho.out);
  assert.equal(flaggedIdentity.model, FLAG_MODEL);
  assert.equal(flaggedIdentity.displayName, `coordinator (${FLAG_MODEL})`);
  const flaggedJoin = coordinatorEvents(flaggedRepo).find(event => event.event_kind === 'join');
  assert.ok(flaggedJoin, 'init records the coordinator registration');
  assert.equal(JSON.parse(flaggedJoin.event_detail).model, FLAG_MODEL);

  const envRepo = coordinatorRepo(box, 'init-environment');
  box.env.PULLBOARD_MODEL = ENV_MODEL;
  const environmentInit = await box.inProcess(envRepo, 'init', '--json');
  assert.equal(environmentInit.code, 0, environmentInit.err || environmentInit.out);
  const environmentWho = await box.inProcess(envRepo, 'whoami', '--json');
  assert.equal(environmentWho.code, 0, environmentWho.err || environmentWho.out);
  const environmentIdentity = JSON.parse(environmentWho.out);
  assert.equal(environmentIdentity.model, ENV_MODEL);
  assert.equal(environmentIdentity.displayName, `coordinator (${ENV_MODEL})`);
  const environmentJoin = coordinatorEvents(envRepo).find(event => event.event_kind === 'join');
  assert.ok(environmentJoin, 'environment-backed init records the coordinator registration');
  assert.equal(JSON.parse(environmentJoin.event_detail).model, ENV_MODEL);

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
  const declaration = fixtureJoin(box.run, declaredRepo, 'coordinator', '--model', LATER_MODEL, '--json');
  assert.equal(declaration.code, 0, declaration.err || declaration.out);
  const declaredIdentity = JSON.parse(declaration.out);
  assert.equal(declaredIdentity.model, LATER_MODEL);
  assert.equal(declaredIdentity.displayName, `coordinator (${LATER_MODEL})`);
  const move = await box.inProcess(declaredRepo, 'shout', 'all', 'the declared coordinator acts');
  assert.equal(move.code, 0, move.err || move.out);
  const declaredEvents = coordinatorEvents(declaredRepo);
  const modelEvent = declaredEvents.find(event => event.event_kind === 'model');
  const shoutEvent = declaredEvents.find(event => event.event_kind === 'shout');
  assert.ok(modelEvent, 'the later declaration is an ordered model event');
  assert.ok(shoutEvent, 'the coordinator records a later move');
  assert.equal(JSON.parse(modelEvent.event_detail).model, LATER_MODEL);
  assert.equal(JSON.parse(shoutEvent.event_detail).model, LATER_MODEL);

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
});
