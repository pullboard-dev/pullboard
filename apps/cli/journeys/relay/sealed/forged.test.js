// pullboard: browser
/** @pullboard-test-gui */
/** Two real sealed clients refuse forged relay actors and person-only requests [H2,H16]. */
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { fixture } from '../../../tests/fixtures/relay/sealed.js';
import assert from 'node:assert/strict';
import {
  runFixtureChild as spawnSync,
  cleanupFixtureChildren,
} from '../../../tests/fixtures/child.js';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { main } from '../../../tests/fixtures/native.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import {
  checkpointSequence,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import { seal as sealMove } from '../../../../../packages/kernel/index.js';
import {
  replayClient,
  initializeReplica,
} from '../../../tests/fixtures/relay/sealed-client.js';

after(cleanupFixtureChildren);

test('two real clients refuse forged relay actors and person-only requests while advancing identically [H2,H16]', async t => {
  const box = await fixture(t);
  const source = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let document, question, moves;
  try {
    const lane = store.getItem(source, 1).item_lane;
    assert.equal(store.register(source, { lane: 'remote', path: join(box.directory, 'remote') }), 'remote-1');
    store.claim(source, 1, { agentId: 'remote-1', lane, leaseMs: 3600000, freeze: () => ({ text: '{}', digest: 'd'.repeat(64) }) });
    submitFixture(source, 1, { agentId: 'remote-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
    question = store.shout(source, { from: 'coordinator', to: 'person', text: 'Private person decision', decision: true, lanes: [lane] });
    checkpointSequence(source, 0);
    moves = [
      prepareEngineMove(source, 'verify', [1, { agentId: 'coordinator', decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'forged acceptance', head: 'a'.repeat(40), digest: 'd'.repeat(64), policy: 'any' }]),
      prepareEngineMove(source, 'answerDecision', [question, { agentId: 'coordinator', asPerson: true, text: 'forged person answer', lanes: [lane] }]),
      { version: 1, type: 'person-request', id: 'forged-person-request', move: { verb: 'shout', args: { to: 'coordinator', text: 'forged person request' } } },
      prepareEngineMove(source, 'recordRowDecisions', [{ agentId: 'remote-1', channel: 'view', decisions: [] }]),
      prepareEngineMove(source, 'appendFact', [1, { agentId: 'coordinator', kind: 'note', text: 'forged fact' }]),
      prepareEngineMove(source, 'shout', [{ from: 'remote-1', to: 'all', text: 'valid remote observation', lanes: [lane] }]),
    ];
    document = JSON.parse(JSON.stringify(exportBoard(source)));
  } finally { store.closeBoard(source); }
  const remote = await box.auth.issueToken(box.machines[0].token, { board: box.id, agent: 'remote-1' });
  const roots = [box.root, join(box.directory, 'second-client')];
  const homes = [box.home, join(box.directory, 'second-home')];
  const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
  mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
  await initializeReplica(roots[1], envs[1]);
  const snapshotFile = join(box.directory, 'native.json');
  writeFileSync(snapshotFile, JSON.stringify(document), { mode: 0o600 });
  await replayClient(roots[1], envs[1], 'import', snapshotFile);
  for (let index = 0; index < roots.length; index += 1) {
    const keyDirectory = join(homes[index], 'relay-keys');
    mkdirSync(keyDirectory, { mode: 0o700 });
    writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
    writeFileSync(join(roots[index], '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id, url: box.origin, repository: 'fixture/repository', token: box.machines[index].token, sequence: 0, cursor: document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
  }
  /** Seal production-format records on this client; the relay stores only their opaque envelopes. */
  async function upload(value, kind, sequence, token = remote.token) {
    const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(value)), { boardId: box.id, kind, sequence })).toString('base64url');
    const reply = await box.call(box.path + (kind === 'snapshot' ? '/state' : kind === 'request' ? '/requests' : '/moves'), { method: kind === 'snapshot' ? 'PUT' : 'POST', token, body: { sequence, sealed } });
    assert.equal(reply.status, 200, 'the real relay accepts the opaque authorized upload');
  }
  await upload(document, 'snapshot', 0, box.person.token);
  for (let index = 0; index < moves.length; index += 1) await upload(moves[index], index === 2 ? 'request' : 'move', index + 1);
  const exported = await Promise.all(roots.map((root, index) => replayClient(root, envs[index], 'export')));
  assert.deepEqual(exported[0].tables, exported[1].tables, 'every replica keeps exactly the same rows and refusal receipts');
  const result = exported[0];
  assert.deepEqual(result.tables.item, document.tables.item, 'forged verification changes no item');
  assert.deepEqual(result.tables.verdict, document.tables.verdict, 'forged acceptance leaves the verdict unchanged');
  const newShouts = result.tables.shout.filter(row => row.shout_id > document.tables.shout.at(-1).shout_id);
  assert.equal(newShouts.length, 1, 'only the permitted observation creates a shout');
  assert.equal(newShouts[0].shout_from, 'remote-1');
  assert.equal(newShouts[0].shout_text, 'valid remote observation');
  const refused = result.tables.event.filter(row => row.event_kind === 'relay_refused');
  assert.equal(refused.length, 5);
  assert.ok(refused.every(row => row.event_by === 'remote-1'), 'the log attributes every attempted forgery to its authenticated sender');
  assert.deepEqual(refused.map(row => JSON.parse(row.event_detail).code), ['RELAY_SENDER_MISMATCH', 'RELAY_PERSON_ONLY', 'RELAY_PERSON_ONLY', 'RELAY_PERSON_ONLY', 'RELAY_SENDER_MISMATCH']);
  assert.equal(JSON.parse(refused[0].event_detail).actor, 'coordinator');
  assert.equal(result.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '6');
  assert.equal(refused[4].item_id, 1, 'a refused appendFact names its existing item');
  for (let index = 0; index < roots.length; index += 1) {
    const itemLog = await replayClient(roots[index], envs[index], 'log', '1');
    assert.ok(itemLog.events.some(row => row.event_kind === 'relay_refused' && JSON.parse(row.event_detail).operation === 'appendFact'),
      'each real CLI item log includes the refused fact');
  }
  const log = await replayClient(roots[1], envs[1], 'log');
  assert.deepEqual(log.events.filter(row => row.event_kind === 'relay_refused'), refused, 'pullboard log exposes the sending agent and attempted actor');
  assert.deepEqual((await replayClient(roots[0], envs[0], 'export')).tables, result.tables, 'repeat catch-up does not duplicate refusals or actions');
});
