// pullboard: browser
/** @pullboard-test-gui */
/** Two real clients and encrypted CLI records exercise the relay without sharing their key [A4,H7]. */
import { fixture } from '../../tests/fixtures/relay/sealed.js';
import assert from 'node:assert/strict';
import {
  runFixtureChild as spawnSync,
  cleanupFixtureChildren,
} from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { exportBoard } from '../../../../packages/store/index.js';
import {
  checkpointSequence,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { seal as sealMove } from '../../../../packages/kernel/index.js';
import {
  replayClient,
  initializeReplica,
  independentReplayOrigin,
  replayResult,
} from '../../tests/fixtures/relay/sealed-client.js';

after(cleanupFixtureChildren);

test('sealed agent shout cannot answer a person decision on either independent client [H16,B26]', async t => {
  const box = await fixture(t);
  const source = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let document, question, forged, ordinary, answer;
  try {
    const lane = store.getItem(source, 1).item_lane;
    assert.equal(store.register(source, { lane: 'remote', path: join(box.directory, 'remote') }), 'remote-1');
    question = store.shout(source, {
      from: 'coordinator', to: 'person', text: 'Approve this change?', decision: true, lanes: [lane],
    });
    checkpointSequence(source, 0);
    // This is intentionally a raw authenticated-agent shout, not answerDecision.
    // The relay must reject its answer relation before insertShout can close the question.
    forged = prepareEngineMove(source, 'shout', [{
      from: 'remote-1', to: 'coordinator', text: 'Forged approval', answers: question, lanes: [lane],
    }]);
    ordinary = prepareEngineMove(source, 'shout', [{
      from: 'remote-1', to: 'all', text: 'Ordinary agent observation', lanes: [lane],
    }]);
    answer = prepareEngineMove(source, 'answerDecision', [question, {
      agentId: 'coordinator', asPerson: true, text: 'Approved by the person', lanes: [lane],
    }]);
    document = JSON.parse(JSON.stringify(exportBoard(source)));
  } finally { store.closeBoard(source); }

  const remote = await box.auth.issueToken(box.machines[0].token, { board: box.id, agent: 'remote-1' });
  const roots = [box.root, join(box.directory, 'second-client')];
  const homes = [box.home, join(box.directory, 'second-home')];
  const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
  mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
  await initializeReplica(roots[1], envs[1]);
  const native = join(box.directory, 'native.json');
  writeFileSync(native, JSON.stringify(document), { mode: 0o600 });
  await replayClient(roots[1], envs[1], 'import', native);
  for (let i = 0; i < roots.length; i++) {
    const keyDirectory = join(homes[i], 'relay-keys');
    mkdirSync(keyDirectory, { mode: 0o700 });
    writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
    const url = await independentReplayOrigin(t, box.origin);
    writeFileSync(join(roots[i], '.git/pullboard/relay.json'), JSON.stringify({
      version: 1, mode: 'ordered', board: box.id, url, repository: 'fixture/repository',
      token: box.machines[i].token, sequence: 0, cursor: document.tables.event.at(-1).event_id,
    }) + '\n', { mode: 0o600 });
  }

  /** Send a production-sealed move using its actual authenticated relay credential. */
  async function upload(move, sequence, token = remote.token) {
    const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(move)), {
      boardId: box.id, kind: 'move', sequence,
    })).toString('base64url');
    const reply = await box.call(box.path + '/moves', {
      method: 'POST', token, body: { sequence, sealed },
    });
    assert.equal(reply.status, 200);
    return reply;
  }
  const snapshot = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(document)), {
    boardId: box.id, kind: 'snapshot', sequence: 0,
  })).toString('base64url');
  assert.equal((await box.call(box.path + '/state', {
    method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: snapshot },
  })).status, 200);
  const forgedUpload = await upload(forged, 1);
  assert.equal(forgedUpload.body.event.sender.agent, 'remote-1');
  await upload(ordinary, 2);

  const refusedReplicas = [];
  for (let i = 0; i < roots.length; i++) {
    const result = await replayResult(roots[i], envs[i], 'export');
    assert.equal(result.status, 0);
    const doc = result.document;
    const q = doc.tables.shout.find(row => row.shout_id === question);
    assert.ok(q && q.shout_decision, 'the person decision remains present');
    assert.equal(doc.tables.shout.some(row => row.shout_answers === question), false, 'the refused agent record did not answer it');
    assert.equal(doc.tables.shout.at(-1).shout_text, 'Ordinary agent observation', 'ordinary agent shouts remain allowed');
    const refusal = doc.tables.event.find(row => row.event_kind === 'relay_refused' && row.event_by === 'remote-1');
    assert.equal(JSON.parse(refusal.event_detail).code, 'RELAY_ANSWER');
    assert.equal(doc.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '2');
    const board = openBoard(join(roots[i], '.git/pullboard/board.sqlite'));
    try { assert.deepEqual(store.openDecisions(board, 'person').map(row => row.shout_id), [question]); }
    finally { store.closeBoard(board); }
    refusedReplicas.push(doc.tables);
  }
  assert.deepEqual(refusedReplicas[0], refusedReplicas[1], 'both clients independently replay the refusal and allowed shout');
  const beforeAnswer = refusedReplicas[0];

  // A valid, sealed person decision preserves the existing guarded answer path.
  await upload(answer, 3, box.person.token);
  const answered = [];
  for (let i = 0; i < roots.length; i++) {
    const result = await replayResult(roots[i], envs[i], 'export');
    assert.equal(result.status, 0);
    const doc = result.document;
    assert.equal(doc.tables.shout.some(row => row.shout_answers === question && row.shout_text === 'Approved by the person'), true);
    assert.equal(doc.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '3');
    assert.deepEqual(doc.tables.event.slice(0, beforeAnswer.event.length), beforeAnswer.event, 'the guarded answer preserves every earlier event row');
    assert.deepEqual(doc.tables.shout.slice(0, beforeAnswer.shout.length), beforeAnswer.shout, 'the guarded answer preserves earlier shout IDs and raw rows');
    const board = openBoard(join(roots[i], '.git/pullboard/board.sqlite'));
    try { assert.deepEqual(store.openDecisions(board, 'person'), []); }
    finally { store.closeBoard(board); }
    answered.push(doc.tables);
  }
  assert.deepEqual(answered[0], answered[1], 'both clients apply the actual guarded person answer identically');
  const retained = await box.call(box.path + '/state');
  assert.equal(retained.body.state.sequence, 0);
  assert.equal(retained.body.state.sealed, snapshot, 'both clients independently replayed rather than importing a published checkpoint');
});
