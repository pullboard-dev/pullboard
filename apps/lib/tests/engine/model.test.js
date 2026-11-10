import { AGENT_GRANT_ENGINE } from '../../../../packages/state/light.js';
import { FAMILY_DECLARE_ENGINE } from '../../../../packages/state/light.js';
/** Declared models replay with their recorded engine and survive board exchange [O8,O3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  AUTO_ESCALATE_ENGINE,
  ENGINE_VERSION,
  MILESTONE_SHIP_ENGINE,
  STRONG_REJECTION_NOTICE_ENGINE,
  VERIFIER_STANDING_ENGINE,
} from '../../../../packages/state/index.js';
import { WITHDRAW_MILESTONE_ENGINE } from '../../../../packages/state/light.js';
import { BOARD_SENTINEL_ENGINE } from '../../../../packages/sentinels/index.js';
import { RIGOR_NOTICE_ENGINE } from '../../../../packages/store/index.js';
import { HEALTH_SENTINEL_ENGINE } from '../../../../packages/store/index.js';
import { CONFLICT_ENGINE } from '../../../../packages/state/light.js';
import {
  configProblems,
  defaults,
  loadConfig,
} from '../../../../packages/config/index.js';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('model declarations and event snapshots retain all supported engine semantics [O8,O3,H16]', (t) => {
  assert.equal(STRONG_REJECTION_NOTICE_ENGINE, 54, 'ceiling notices retain their allocated feature engine');
  assert.ok(ENGINE_VERSION >= STRONG_REJECTION_NOTICE_ENGINE, 'the current writer retains paired ceiling notices');
  assert.equal(AUTO_ESCALATE_ENGINE, 50, 'automatic escalation retains its allocated engine');
  assert.equal(WITHDRAW_MILESTONE_ENGINE, 51, 'withdraw retains its allocated feature engine');
  assert.ok(ENGINE_VERSION >= WITHDRAW_MILESTONE_ENGINE, 'the current writer includes the withdraw feature');
  assert.equal(CONFLICT_ENGINE, 52, 'trunk conflict retains its allocated feature engine');
  assert.ok(ENGINE_VERSION >= CONFLICT_ENGINE, 'the current writer retains trunk-conflict semantics');
  assert.ok(ENGINE_VERSION >= AUTO_ESCALATE_ENGINE, 'the current writer retains automatic escalation');
  assert.equal(MILESTONE_SHIP_ENGINE, 45, 'shipment retains its engine-45 meaning');
  assert.ok(ENGINE_VERSION >= MILESTONE_SHIP_ENGINE, 'the current writer retains all milestone shipment behavior');
  assert.ok(ENGINE_VERSION >= VERIFIER_STANDING_ENGINE, 'the current writer retains verifier standing');
  assert.ok(ENGINE_VERSION >= RIGOR_NOTICE_ENGINE, 'the next writer preserves every historical model snapshot through main engine 33');
  assert.ok(ENGINE_VERSION >= HEALTH_SENTINEL_ENGINE, 'the current writer retains the sentinel minimum and historical behavior');
  assert.equal(BOARD_SENTINEL_ENGINE, 56, 'board watches retain their allocated feature engine');
  assert.ok(ENGINE_VERSION >= BOARD_SENTINEL_ENGINE, 'the current writer retains board-watch semantics');
  for (const version of Array.from({ length: ENGINE_VERSION }, (_, index) => index + 1)) {
    const board = openBoard(':memory:');
    t.after(() => store.closeBoard(board));
    const registration = prepareEngineMove(board, 'register', [{ lane: 'web', path: '/web', model: 'First Model', family: 'First Vendor' }]);
    const first = applyEngineMove(board, { ...registration, engine: version }, { sequence: 1, at: '2026-10-10T07:00:00Z' });
    assert.equal(first.error, undefined);
    assert.equal(first.result, 'web-1');
    assert.equal(store.agentAt(board, '/web').agent_model, version < 8 ? null : 'First Model');
    const joinedDetail = version < 8 ? { lane: 'web' } : { lane: 'web', model: 'First Model',
      ...(version >= AGENT_GRANT_ENGINE ? { grantEngine: AGENT_GRANT_ENGINE } : {}),
      ...(version >= FAMILY_DECLARE_ENGINE ? { family: 'First Vendor' } : {}) };
    assert.deepEqual(JSON.parse(first.events[0].event_detail), joinedDetail);

    const update = prepareEngineMove(board, 'register', [{ lane: 'web', path: '/web', model: 'Second Model' }]);
    const changed = applyEngineMove(board, { ...update, engine: version }, { sequence: 2, at: '2026-10-10T07:01:00Z' });
    assert.equal(changed.error, undefined);
    assert.equal(changed.result, 'web-1');
    assert.equal(changed.events.length, version < 8 ? 0 : 1);
    assert.equal(store.agentAt(board, '/web').agent_model, version < 8 ? null : 'Second Model');
    if (version >= 8) {
      assert.equal(changed.events[0].event_kind, 'model');
      assert.deepEqual(JSON.parse(changed.events[0].event_detail), { model: 'Second Model' });
      assert.deepEqual(JSON.parse(store.events(board)[0].event_detail), joinedDetail,
        'later model changes never rewrite an earlier move snapshot');
    }
  }
});

test('exchanged replicas keep models and record identical later agent moves [O8,O3,H16]', (t) => {
  const source = openBoard(':memory:');
  const replica = openBoard(':memory:');
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
