/** Explicit effects select a governing owner without granting execution authority [D1,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused } from '../../../../packages/kernel/light.js';
import { rulingOwner } from '../../../../packages/spec/index.js';
import { RULING_EFFECT_OPERATIONS } from '../../../../packages/spec/index.js';

/** Supply trusted native-like row records; input declarations never supply their status. */
function context() {
  const rows = new Map(['approved', 'draft', 'pending', 'fact', 'wont', 'retired']
    .map((status, index) => [`R${index + 1}`, { id: `R${index + 1}`, status }]));
  rows.set('doctrine:R1', { id: 'R1', status: 'approved' });
  return { readRow: id => rows.get(id) };
}

/** Require the named refusal, not an incidental TypeError or a truthy output. */
function refuses(work, code) {
  assert.throws(work, error => error instanceof Refused && error.code === code);
}

test('unchanged approved-row implementation belongs to its agent; every revision and approval belongs to the person [D1,N26]', () => {
  const ctx = context();
  assert.equal(rulingOwner([{ op: 'implement-row', row: 'R1' }], ctx).owner, 'agent');
  assert.equal(rulingOwner([{ op: 'implement-row', row: 'doctrine:R1' }], ctx).owner, 'agent');
  for (const row of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
    for (const op of ['revise-row', 'approve-row']) assert.equal(rulingOwner([{ op, row }], ctx).owner, 'person');
  }
  for (const row of ['R2', 'R3', 'R4', 'R5', 'R6']) {
    refuses(() => rulingOwner([{ op: 'implement-row', row }], ctx), 'RULING_ROW');
  }
});

test('specific existing coordinator and person-mode effects retain their different routing owners [D1,N26]', () => {
  const cases = [
    [{ op: 'withdraw', item: 3 }, 'coordinator'],
    [{ op: 'merged', item: 3, commit: 'a'.repeat(40) }, 'coordinator'],
    [{ op: 'applyRowDecisions', events: [11, 12] }, 'coordinator'],
    [{ op: 'recordLandingWaiver', test: 'test/one.test.js' }, 'person'],
  ];
  for (const [effect, owner] of cases) assert.equal(rulingOwner([effect]).owner, owner);
  assert.deepEqual(new Set([...cases.map(([effect]) => effect.op), 'implement-row', 'revise-row', 'approve-row']), new Set(RULING_EFFECT_OPERATIONS), 'every supported operation has an explicit routing control');
});

test('mixed effects choose person then coordinator then agent independent of declaration order [D1,N26]', () => {
  const own = { op: 'implement-row', row: 'R1' };
  const coordinator = { op: 'withdraw', item: 3 };
  const person = { op: 'revise-row', row: 'R2' };
  for (const effects of [[own, coordinator], [coordinator, own]]) assert.equal(rulingOwner(effects, context()).owner, 'coordinator');
  for (const effects of [[own, coordinator, person], [own, person, coordinator], [coordinator, own, person],
    [coordinator, person, own], [person, own, coordinator], [person, coordinator, own]]) {
    assert.equal(rulingOwner(effects, context()).owner, 'person');
  }
});

test('empty or nonspecific effects never silently become an agent-owned request [D1,N26]', () => {
  for (const effects of [undefined, null, [], {}, { effects: [{ op: 'withdraw', item: 3 }], owner: 'agent' }]) {
    refuses(() => rulingOwner(effects, context()), 'RULING_EFFECTS');
  }
  for (const effect of [{}, { op: 'none' }, { op: 'own-proposal' }, { op: 'implement-row' },
    { op: 'withdraw' }, { op: 'withdraw', item: 0 }, { op: 'withdraw', item: '#3' },
    { op: 'merged', item: 3, commit: 'short' }, { op: 'applyRowDecisions', events: [] },
    { op: 'applyRowDecisions', events: [1, 1] }, { op: 'holdLane', lane: 'view' },
    { op: 'answerDecision', shout: 7, asPerson: 'false' }, { op: 'recordLandingWaiver', test: '../one.test.js' }]) {
    refuses(() => rulingOwner([effect], context()), 'RULING_EFFECT');
  }
  refuses(() => rulingOwner(new Array(1), context()), 'RULING_EFFECT');
});

test('declared owner, status, actor and extra row changes cannot override native row evidence [D1,N26]', () => {
  for (const extra of [{ owner: 'agent' }, { status: 'approved' }, { agentId: 'coordinator' },
    { text: 'replacement' }, { gate: 'weakened' }, { mode: 'person' }]) {
    refuses(() => rulingOwner([{ op: 'revise-row', row: 'R2', ...extra }], context()), 'RULING_EFFECT');
  }
  refuses(() => rulingOwner([{ op: 'implement-row', row: 'absent' }], context()), 'RULING_ROW');
  refuses(() => rulingOwner([{ op: 'implement-row', row: ' R1' }], context()), 'RULING_EFFECT');
  refuses(() => rulingOwner([{ op: 'implement-row', row: 'R1' }], { readRow: () => ({ id: 'R2', status: 'approved' }) }), 'RULING_ROW');
  refuses(() => rulingOwner([{ op: 'implement-row', row: 'R1' }], { readRow: () => ({ id: 'R1', status: 'unknown' }) }), 'RULING_ROW');
});

test('routing reads each qualified row once, preserves declarations and never substitutes a fallback on reader failure [D1,N26]', () => {
  const input = Object.freeze([Object.freeze({ op: 'implement-row', row: 'R1' }), Object.freeze({ op: 'revise-row', row: 'R1' })]);
  let reads = 0;
  const result = rulingOwner(input, { readRow: () => { reads += 1; return { id: 'R1', status: 'approved' }; } });
  assert.equal(reads, 1);
  assert.equal(result.owner, 'person');
  assert.deepEqual(result.effects.map(entry => entry.effect), input);
  const unavailable = new Error('fixture snapshot unavailable');
  assert.throws(() => rulingOwner([{ op: 'implement-row', row: 'R1' }], { readRow: () => { throw unavailable; } }), error => error === unavailable);
  refuses(() => rulingOwner([input[0], input[0]], context()), 'RULING_EFFECT');
  result.effects[0].effect.row = 'changed';
  assert.equal(input[0].row, 'R1', 'the returned result does not alias the caller declaration');
});


test('real requests persist effects, recompute from current rows and confer no move authority [D1,N26,B26]', async t => {
  const { proveRulingOwnerCli } = await import('../../tests/fixtures/owner.js');
  proveRulingOwnerCli(t);
});

test('malformed or forged ruling effects append no request through the real CLI [D1,N26]', async t => {
  const { proveRulingOwnerRefusals } = await import('../../tests/fixtures/owner.js');
  proveRulingOwnerRefusals(t);
});

test('declared effects replay exactly, preserve legacy meaning and refuse older engines [D1,N26,H16]', async t => {
  const store = await import('../../../../packages/store/index.js');
  const nativeBoard = await import('../../../lib/index.js');
  const { prepareEngineMove, applyEngineMove } = await import('../../../../packages/state/index.js');
  const { exportBoard, importBoard } = await import('../../../../packages/store/index.js');
  const { RULING_OWNER_ENGINE } = await import('../../../../packages/state/light.js');
  const source = nativeBoard.openBoard(':memory:'), replica = nativeBoard.openBoard(':memory:'), restored = nativeBoard.openBoard(':memory:');
  t.after(() => { for (const board of [source, replica, restored]) store.closeBoard(board); });
  store.register(source, { lane: 'coordinator', path: '/ruling-fixture' });
  store.register(source, { lane: 'web', path: '/ruling-fixture/web' });
  importBoard(replica, exportBoard(source));
  const effects = [{ op: 'implement-row', row: 'G1' }];
  const message = { from: 'web-1', to: 'coordinator', text: 'A declared outcome', decision: true, effects, lanes: ['coordinator', 'web'] };
  const move = prepareEngineMove(source, 'shout', [message], { id: 'ruling-effects', actor: 'web-1' });
  const at = new Date().toISOString();
  assert.throws(() => applyEngineMove(replica, { ...move, engine: RULING_OWNER_ENGINE - 1 }, { sequence: 1, at }), /RELAY_MOVE/u);
  assert.deepEqual(store.openDecisions(replica), []);
  applyEngineMove(replica, move, { sequence: 1, at });
  assert.deepEqual(store.openDecisions(replica)[0].effects, effects);
  assert.equal(store.openDecisions(replica)[0].ruling, undefined, 'history stores the declaration, never a caller-chosen owner');
  importBoard(restored, exportBoard(replica));
  assert.deepEqual(store.openDecisions(restored), store.openDecisions(replica));
  const before = store.events(replica).length;
  refuses(() => store.shout(replica, { ...message, effects: [] }), 'RULING_EFFECTS');
  assert.equal(store.events(replica).length, before);
  const legacy = prepareEngineMove(replica, 'shout', [{ from: 'web-1', to: 'coordinator', text: 'Opaque old detail',
    decision: true, lanes: ['coordinator', 'web'], detail: { decisionEffects: effects, ruling: { owner: 'agent' } } }],
  { id: 'old-ruling-detail', actor: 'web-1' });
  applyEngineMove(replica, { ...legacy, engine: 1 }, { sequence: 2, at });
  const old = store.openDecisions(replica).find(row => row.shout_text === 'Opaque old detail');
  assert.equal(old.effects, undefined, 'legacy opaque data never acquires new declared-effect meaning');
});
