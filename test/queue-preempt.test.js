/** Emergency routing retains person authority and never evicts active work [N2,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { mainRedBuildRouting } from '../packages/store/index.js';
import { QUEUE_PREEMPT_ENGINE } from '../src/queue-preempt-engine.js';
import { prepareEngineMove } from '../packages/state/index.js';
import { applyRelayMove } from '../packages/state/index.js';
import { fixtureBoard } from './board-fixture.js';

/** A private native board with explicit readiness, person marks and observed work. */
function fixture(t) {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/private/preempt-main' });
  const seat = store.register(board, { lane: 'web', path: '/private/preempt-builder', route: 'strong' });
  const add = title => store.addItem(board, { by: 'coordinator', lane: 'web', title,
    criterion: 'Emergency routing preserves current work.', check: 'true' });
  const mark = (id, text, extra = {}) => store.appendFact(board, id, { agentId: 'coordinator', kind: 'urgent',
    text, asPerson: true, channel: 'view', ...extra });
  return { board, seat, add, mark };
}

test('only the person marks urgency; marked and main-red items lead eligible native next [N2,B3]', t => {
  const f = fixture(t);
  const ordinary = f.add('Earlier ordinary work');
  const urgent = f.add('Later urgent work');
  const events = store.events(f.board).length;
  for (const options of [{ agentId: f.seat }, { asPerson: false }, { channel: 'agent' }, { text: 'maybe' }]) {
    assert.throws(() => f.mark(urgent, 'on', options), /B26_PERSON_APPROVAL|B26_PERSON_CHANNEL|URGENT_VALUE/u);
    assert.equal(store.events(f.board).length, events);
  }
  const forged = prepareEngineMove(f.board, 'appendFact', [urgent, { agentId: 'coordinator', kind: 'urgent',
    text: 'on', asPerson: true, channel: 'view' }], { id: 'forged-urgency', actor: 'coordinator' });
  const refused = applyRelayMove(f.board, forged, { sequence: 1, at: new Date().toISOString(), kind: 'move',
    sender: { kind: 'agent', agent: f.seat, userId: 'fixture' } });
  assert.equal(refused.error.code, 'RELAY_PERSON_ONLY');
  f.mark(urgent, 'on');
  assert.equal(store.itemThread(f.board, urgent).filter(row => row.type === 'fact').at(-1).by, 'person');
  assert.equal(store.nextFor(f.board, { agentId: f.seat, lane: 'web' }).item.item_id, urgent);
  f.mark(urgent, 'off');
  assert.equal(store.nextFor(f.board, { agentId: f.seat, lane: 'web' }).item.item_id, ordinary);
  assert.equal(store.nextFor(f.board, { agentId: f.seat, lane: 'web', priority: [urgent] }).item.item_id, urgent,
    'trusted main-red evidence needs no person mark');
  f.board.executionEngineVersion = QUEUE_PREEMPT_ENGINE - 1;
  assert.throws(() => f.mark(urgent, 'on'), /BAD_FACT_KIND/u, 'old moves cannot introduce a future mark');
});

test('only a demonstrably waiting clean claim may yield; dirty, committed and unknown work stay protected [N2,B3]', t => {
  const f = fixture(t);
  const waiting = f.add('Claimed work');
  store.claim(f.board, waiting, { agentId: f.seat, lane: 'web', leaseMs: 7_200_000,
    freeze: item => ({ text: item.item_title, digest: 'private-preemption' }) });
  const repair = f.add('Urgent repair');
  f.mark(repair, 'on');
  const clean = new Map([[waiting, { files: [], unknown: false }]]);
  const route = workingFiles => mainRedBuildRouting(f.board, { caller: f.seat, workingFiles });
  assert.equal(route(clean), null, 'a clean but actively building claim is not waiting');
  const blocker = f.add('New unsatisfied prerequisite');
  store.editItem(f.board, waiting, { agentId: 'coordinator', after: [blocker] });
  const before = store.exportBoard(f.board);
  const offered = route(clean);
  assert.deepEqual(offered.releaseRequest, { seat: f.seat, item: waiting, repair, path: '/private/preempt-builder' });
  assert.deepEqual(store.exportBoard(f.board), before, 'planning itself never steals a lease');
  for (const observation of [undefined, { files: [], unknown: true }, { files: ['web/work.js'], unknown: false }]) {
    assert.equal(route(new Map(observation ? [[waiting, observation]] : [])), null);
  }
  const other = store.register(f.board, { lane: 'web', path: '/private/preempt-free', route: 'strong' });
  assert.equal(route(clean).buildOffer.seat, other, 'a free eligible seat wins over releasing any waiting claim');
});
