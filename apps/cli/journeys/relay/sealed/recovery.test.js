/** Sealed relay recovery keeps two future-engine blockers recovering one durable position at a time [H3,H16]. */
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import { fixture } from '../../../tests/fixtures/relay/sealed.js';
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../tests/fixtures/child.js';
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { store } from '../../../tests/fixtures/relay/sealed-client.js';
import { openBoard } from '../../../tests/fixtures/relay/sealed-client.js';
import { exportBoard } from '../../../tests/fixtures/relay/sealed-client.js';
import { checkpointSequence } from '../../../tests/fixtures/relay/sealed-client.js';
import { sealMove } from '../../../tests/fixtures/relay/sealed-client.js';
import { ENGINE_VERSION } from '../../../tests/fixtures/relay/sealed-client.js';
import { relayRecover } from '../../../tests/fixtures/relay/sealed-client.js';
import { syncRelay } from '../../../tests/fixtures/relay/sealed-client.js';
import { main } from '../../../tests/fixtures/native.js';
import { replayClient } from '../../../tests/fixtures/relay/sealed-client.js';
import { initializeReplica } from '../../../tests/fixtures/relay/sealed-client.js';

after(cleanupFixtureChildren);

test('two future-engine blockers recover one durable position at a time on two real clients [H3,H16]', async t => {
  const box = await fixture(t);
  const roots = [box.root, join(box.directory, 'second-recovery-client')];
  const homes = [box.home, join(box.directory, 'second-recovery-home')];
  const envs = homes.map(home => ({ ...box.env, HOME: home, PULLBOARD_HOME: home }));
  const source = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
  let document;
  try { checkpointSequence(source, 0); document = exportBoard(source); }
  finally { store.closeBoard(source); }
  mkdirSync(roots[1]); mkdirSync(homes[1], { mode: 0o700 });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: roots[1], env: envs[1] }).status, 0);
  await initializeReplica(roots[1], envs[1]);
  const initial = join(box.directory, 'two-blockers-native.json');
  writeFileSync(initial, JSON.stringify(document), { mode: 0o600 });
  await replayClient(roots[1], envs[1], 'import', initial);
  for (let index = 0; index < roots.length; index += 1) {
    mkdirSync(join(homes[index], 'relay-keys'), { mode: 0o700 });
    writeFileSync(join(homes[index], 'relay-keys', box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
    writeFileSync(join(roots[index], '.git/pullboard/relay.json'), JSON.stringify({ version: 1, mode: 'ordered', board: box.id,
      url: box.origin, repository: 'fixture/repository', token: box.machines[index].token, sequence: 0,
      cursor: document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
  }
  /** Upload only sealed records through the real authenticated relay. */
  async function upload(value, kind, sequence, token) {
    const sealed = Buffer.from(await sealMove(box.key, Buffer.from(JSON.stringify(value)), { boardId: box.id, kind, sequence })).toString('base64url');
    const reply = await box.call(box.path + (kind === 'snapshot' ? '/state' : '/moves'), {
      method: kind === 'snapshot' ? 'PUT' : 'POST', token, body: { sequence, sealed },
    });
    assert.equal(reply.status, 200);
  }
  await upload(document, 'snapshot', 0, box.person.token);
  for (let sequence = 1; sequence <= 5; sequence += 1) await upload({ version: 1, engine: ENGINE_VERSION,
    id: 'prefix-' + sequence, operation: 'unknownCurrentOperation', args: [] }, 'move', sequence, box.one.token);
  for (let index = 0; index < roots.length; index += 1) await replayClient(roots[index], envs[index], 'relay');
  for (const sequence of [6, 7]) await upload({ version: 1, engine: ENGINE_VERSION + 1, id: 'future-' + sequence,
    operation: 'futureOperation', args: [] }, 'move', sequence, box.one.token);
  await upload({ version: 1, engine: ENGINE_VERSION, id: 'later-person-eight', operation: 'shout',
    args: [{ from: 'person', to: 'coordinator', text: 'Person after two blockers', lanes: ['web'] }] }, 'move', 8, box.person.token);
  const previousHome = process.env.PULLBOARD_HOME;
  t.after(() => { if (previousHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = previousHome; });
  process.env.PULLBOARD_HOME = box.home;
  const io = { ...apiBoardOpeners, say: () => {}, err: () => {} };
  assert.equal((await syncRelay(box.root, io)).sequence, 5);
  const first = await relayRecover(box.root, 6, io);
  assert.equal(first.sequence, 6, 'later engine99 record cannot roll back the selected skip');
  assert.equal((await box.call('/api/v2/boards/' + box.id + '/state')).body.state.sequence, 6, 'skip6 is durably published before skip7');
  await replayClient(roots[1], envs[1], 'relay');
  const afterFirst = await replayClient(roots[1], envs[1], 'export');
  assert.equal(afterFirst.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '6');
  assert.ok(afterFirst.tables.event.some(row => row.event_kind === 'relay_refused' && JSON.parse(row.event_detail).sequence === 6));
  assert.equal(afterFirst.tables.shout.some(row => row.shout_text === 'Person after two blockers'), false);
  const second = await relayRecover(box.root, 7, io);
  assert.equal(second.sequence, 8, 'the second explicit skip replays the later person move');
  const exports = [];
  for (let index = 0; index < roots.length; index += 1) exports.push(await replayClient(roots[index], envs[index], 'export'));
  assert.deepEqual(exports[0].tables, exports[1].tables, 'both native replicas converge without off/on');
  assert.equal(exports[0].tables.shout.filter(row => row.shout_text === 'Person after two blockers').length, 1);
  assert.deepEqual(exports[0].tables.event.filter(row => row.event_kind === 'relay_refused').map(row => JSON.parse(row.event_detail).sequence).slice(-2), [6, 7]);
});
