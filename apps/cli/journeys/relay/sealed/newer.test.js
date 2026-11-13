// pullboard: browser
/** @pullboard-test-gui */
/** Two real sealed clients stop before sender checks for newer operations and actor layouts [H16]. */
import { fixture } from '../../../tests/fixtures/relay/sealed.js';
import assert from 'node:assert/strict';
import {
  runFixtureChild as spawnSync,
  cleanupFixtureChildren,
} from '../../../tests/fixtures/child.js';
import {
  mkdirSync,
  readFileSync,
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
} from '../../../../../packages/state/index.js';
import { seal as sealMove } from '../../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import {
  replayClient,
  initializeReplica,
  independentReplayOrigin,
  replayResult,
} from '../../../tests/fixtures/relay/sealed-client.js';

after(cleanupFixtureChildren);

test('two real clients stop before sender checks for newer operations and actor layouts without advancing [H16]', async t => {
  const futureEngine = ENGINE_VERSION + 1;
  const versionMessage = new RegExp(`engine version ${futureEngine}.*engine version ${ENGINE_VERSION}`);
  const unknown = { version: 1, engine: futureEngine, id: 'future-operation', operation: 'futureOp', args: [{ agentId: 'remote-1' }] };
  const shifted = { version: 1, engine: futureEngine, id: 'future-claim', operation: 'claim', args: [1, {}, { agentId: 'remote-1' }] };
  for (const [name, moves] of [['new operation', [unknown]], ['new actor layout', [shifted]], ['current engine sender checks', [unknown, shifted].map(move => ({ ...move, engine: ENGINE_VERSION }))]]) {
    await t.test(name, async sub => {
      const box = await fixture(sub);
      const source = openBoard(join(box.root, '.git/pullboard/board.sqlite'));
      let document;
      try {
        checkpointSequence(source, 0);
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
      const links = roots.map(root => join(root, '.git/pullboard/relay.json'));
      for (let index = 0; index < roots.length; index += 1) {
        const keyDirectory = join(homes[index], 'relay-keys');
        mkdirSync(keyDirectory, { mode: 0o700 });
        writeFileSync(join(keyDirectory, box.id + '.key'), box.key.toString('base64url') + '\n', { mode: 0o600 });
        const replayOrigin = await independentReplayOrigin(sub, box.origin);
        writeFileSync(links[index], JSON.stringify({ version: 1, mode: 'ordered', board: box.id, url: replayOrigin, repository: 'fixture/repository', token: box.machines[index].token, sequence: 0, cursor: document.tables.event.at(-1).event_id }) + '\n', { mode: 0o600 });
      }
      const originalLinks = links.map(file => readFileSync(file, 'utf8'));
      const initialSnapshot = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(document)), { boardId: box.id, kind: 'snapshot', sequence: 0 })).toString('base64url');
      assert.equal((await box.call(box.path + '/state', { method: 'PUT', token: box.person.token, body: { sequence: 0, sealed: initialSnapshot } })).status, 200);
      for (let index = 0; index < moves.length; index += 1) {
        const sequence = index + 1;
        const sealed = Buffer.from(await sealMove(box.key, new TextEncoder().encode(JSON.stringify(moves[index])), { boardId: box.id, kind: 'move', sequence })).toString('base64url');
        const uploaded = await box.call(box.path + '/moves', { method: 'POST', token: remote.token, body: { sequence, sealed } });
        assert.equal(uploaded.status, 200);
        assert.equal(uploaded.body.event.sender.agent, 'remote-1');
      }
      const results = [];
      for (let index = 0; index < roots.length; index += 1) {
        const result = await replayResult(roots[index], envs[index], 'export');
        assert.equal(result.status, 0);
        results.push(result.document);
        if (moves[0].engine === futureEngine) {
          assert.match((result.document.diagnostics ?? []).join('\n'), new RegExp(`\\[ENGINE_VERSION\\].*${versionMessage.source}.*upgrade pullboard`), 'future records stop before interpreting the sending agent');
          assert.deepEqual(result.document.tables, document.tables, 'no board row, receipt or persisted cursor changes');
          assert.equal(readFileSync(links[index], 'utf8'), originalLinks[index], 'the saved transport cursor is unchanged');
          const retried = await replayResult(roots[index], envs[index], 'export');
          assert.match((retried.document.diagnostics ?? []).join('\n'), /\[ENGINE_VERSION\]/);
          assert.equal(retried.status, 0);
          assert.deepEqual(retried.document.tables, document.tables, 'retry still stops at the same unapplied record');
          const attempted = await replayResult(roots[index], envs[index], 'add', document.tables.item[0].item_lane, 'Later local move must wait');
          assert.equal(attempted.status, 1);
          assert.equal(attempted.document.error.code, 'ENGINE_VERSION');
          assert.match(attempted.document.error.message, versionMessage);
          assert.equal(readFileSync(links[index], 'utf8'), originalLinks[index]);
          const board = openBoard(join(roots[index], '.git/pullboard/board.sqlite'));
          try { assert.deepEqual(JSON.parse(JSON.stringify(exportBoard(board))).tables, document.tables, 'a later local mutation cannot pass the future record'); }
          finally { store.closeBoard(board); }
        } else {
          assert.doesNotMatch((result.document.diagnostics ?? []).join('\n'), /\[ENGINE_VERSION\]/);
          assert.deepEqual(result.document.tables.item, document.tables.item);
          assert.deepEqual(result.document.tables.shout, document.tables.shout);
          assert.deepEqual(result.document.tables.verdict, document.tables.verdict);
          const refused = result.document.tables.event.filter(row => row.event_kind === 'relay_refused');
          assert.deepEqual(refused.map(row => JSON.parse(row.event_detail).code), ['RELAY_SENDER_MISMATCH', 'RELAY_SENDER_MISMATCH']);
          assert.ok(refused.every(row => row.event_by === 'remote-1'));
          assert.equal(result.document.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value, '2');
          assert.equal(JSON.parse(readFileSync(links[index], 'utf8')).sequence, 2);
        }
      }
      assert.deepEqual(results[0].tables, results[1].tables, 'the two independent clients retain identical board rows');
      const snapshot = await box.call(box.path + '/state');
      assert.equal(snapshot.body.state.sequence, 0);
      assert.equal(snapshot.body.state.sealed, initialSnapshot, 'neither client replaced independent replay with a shared checkpoint');
    });
  }
});
