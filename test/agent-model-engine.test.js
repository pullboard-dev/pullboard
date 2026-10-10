/** Declared models replay with their recorded engine and survive board exchange [O8,O3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { configProblems, defaults, loadConfig } from '../src/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('model declarations and event snapshots retain engines 1 through 7 semantics [O8,O3,H16]', (t) => {
  assert.equal(ENGINE_VERSION, 8, 'model moves share the approved 0.8.5 engine');
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const board = store.openBoard(':memory:');
    t.after(() => store.closeBoard(board));
    const registration = prepareEngineMove(board, 'register', [{ lane: 'web', path: '/web', model: 'First Model' }]);
    const first = applyEngineMove(board, { ...registration, engine: version }, { sequence: 1, at: '2026-10-10T07:00:00Z' });
    assert.equal(first.error, undefined);
    assert.equal(first.result, 'web-1');
    assert.equal(store.agentAt(board, '/web').agent_model, version < 8 ? null : 'First Model');
    assert.deepEqual(JSON.parse(first.events[0].event_detail), version < 8
      ? { lane: 'web' } : { lane: 'web', model: 'First Model' });

    const update = prepareEngineMove(board, 'register', [{ lane: 'web', path: '/web', model: 'Second Model' }]);
    const changed = applyEngineMove(board, { ...update, engine: version }, { sequence: 2, at: '2026-10-10T07:01:00Z' });
    assert.equal(changed.error, undefined);
    assert.equal(changed.result, 'web-1');
    assert.equal(changed.events.length, version < 8 ? 0 : 1);
    assert.equal(store.agentAt(board, '/web').agent_model, version < 8 ? null : 'Second Model');
    if (version === 8) {
      assert.equal(changed.events[0].event_kind, 'model');
      assert.deepEqual(JSON.parse(changed.events[0].event_detail), { model: 'Second Model' });
      assert.deepEqual(JSON.parse(store.events(board)[0].event_detail), { lane: 'web', model: 'First Model' },
        'later model changes never rewrite an earlier move snapshot');
    }
  }
});

test('exchanged replicas keep models and record identical later agent moves [O8,O3,H16]', (t) => {
  const source = store.openBoard(':memory:');
  const replica = store.openBoard(':memory:');
  t.after(() => { store.closeBoard(source); store.closeBoard(replica); });
  const id = store.register(source, { lane: 'web', path: '/web', model: 'Declared Model' });
  importBoard(replica, exportBoard(source));
  assert.equal(store.agentAt(replica, '/web').agent_model, 'Declared Model');
  const move = prepareEngineMove(source, 'shout', [{ from: id, to: 'person', text: 'Keep web-1 literal', lanes: ['web'] }]);
  const receipt = { sequence: 1, at: '2026-10-10T07:02:00Z' };
  const one = applyEngineMove(source, move, receipt);
  const two = applyEngineMove(replica, move, receipt);
  assert.equal(one.error, undefined);
  assert.deepEqual(two, one);
  assert.equal(one.events[0].event_by, 'web-1');
  assert.equal(JSON.parse(one.events[0].event_detail).model, 'Declared Model');
  assert.deepEqual(exportBoard(replica), exportBoard(source));
});

test('agent name options preserve valid defaults and refuse invalid objects [O8]', (t) => {
  assert.equal(defaults().agents.names, 'suffix');
  const root = mkdtempSync(join(tmpdir(), 'pullboard-agent-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const agents of [null, 'prefix', [], { names: 'other' }]) {
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ agents }));
    assert.throws(() => loadConfig(root), (error) => error.code === 'BAD_CONFIG');
  }
  assert.deepEqual(configProblems({ ...defaults(), agents: { names: 'prefix' } }), []);
});
