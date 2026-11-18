/** The relay outbox table: every state lists its legal moves or refuses with a next step, a stop at any rebuild step has one way forward, and generated sequences never lose or double a move [C7,#6729,#6728]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OUTBOX_LEGAL,
  OUTBOX_MOVES,
  OUTBOX_RULES,
  OUTBOX_STATES,
  OUTBOX_TABLE,
  explainTable,
  runTable,
  seeded,
  tableCases,
} from '../../../index.js';

const outbox = (over = {}) => ({ state: 'queued', baseSequence: 10, moves: 4, sent: 0, receipted: 0, parked: 0, remade: 0, ...over });
const snap = (over = {}, board = 10) => ({ outbox: outbox(over), board: { sequence: board } });
const run = (snapshot, move) => runTable(OUTBOX_TABLE, OUTBOX_RULES, snapshot, move);

test('moves.outbox.every-outbox-state-is-a-row: every outbox state is a row: each move from it is legal or refused with the legal moves named [C7,#6729]', () => {
  for (const state of OUTBOX_STATES) {
    assert.ok(Array.isArray(OUTBOX_LEGAL[state]), `${state} has a row`);
    for (const name of OUTBOX_MOVES) {
      if (OUTBOX_LEGAL[state].includes(name)) continue;
      const answer = run(snap({ state, moves: state === 'none' ? 0 : 4 }), { name });
      assert.equal(answer.refused.code, 'OUTBOX_ILLEGAL_MOVE', `${state} ${name}`);
      assert.ok(!('patch' in answer));
      for (const legal of OUTBOX_LEGAL[state]) assert.ok(answer.refused.next.includes(legal), `${state} names ${legal}`);
    }
  }
  assert.equal(run(snap({ state: 'bogus' }), { name: 'send' }).refused.code, 'OUTBOX_UNKNOWN_STATE');
  assert.equal(run(snap(), { name: 'nap' }).refused.code, 'OUTBOX_UNKNOWN_MOVE');
});

test('moves.outbox.an-acknowledged-prefix-applied-with-the: an acknowledged prefix applied with the outbox base behind it is a state with a recovery, not a refusal (GitHub #15) [C7,#6729,#6728]', () => {
  const stranded = snap({ state: 'sent', moves: 5, sent: 5, receipted: 3 }, 13);
  const retry = run(stranded, { name: 'takeBack' });
  assert.equal(retry.refused.code, 'OUTBOX_BEHIND');
  assert.match(retry.refused.next, /resume/);
  const resumed = run(stranded, { name: 'resume' });
  assert.deepEqual([resumed.patch.outbox.state, resumed.via], ['applied', ['resume']]);
  const finished = run({ ...stranded, outbox: { ...resumed.patch.outbox, remade: 2 } }, { name: 'write' });
  assert.deepEqual([finished.patch.outbox.moves, finished.patch.outbox.baseSequence, finished.patch.outbox.state], [2, 13, 'queued']);
  assert.equal(run(snap(), { name: 'resume' }).refused.code, 'OUTBOX_NOT_STRANDED');
});

test('moves.outbox.a-checkpoint-older-than-the-outbox: a checkpoint older than the outbox base is refused, never restored [C7,#6729]', () => {
  assert.equal(run(snap({}, 10), { name: 'fallback', checkpoint: 6 }).refused.code, 'RELAY_OUTBOX');
  assert.equal(run(snap(), { name: 'fallback' }).refused.code, 'RELAY_OUTBOX');
  assert.equal(run(snap(), { name: 'fallback', checkpoint: 10 }).patch.outbox.state, 'applied');
});

test('moves.outbox.acknowledge-send-and-park-refuse-a: acknowledge, send and park refuse a count the outbox does not hold [C7,#6729]', () => {
  assert.equal(run(snap({ state: 'sent', sent: 1 }), { name: 'acknowledge', count: 2 }).refused.code, 'OUTBOX_ACK_UNSENT');
  assert.equal(run(snap({ state: 'sent', sent: 4 }), { name: 'send' }).refused.code, 'OUTBOX_NOTHING_TO_SEND');
  assert.equal(run(snap({ state: 'sent', parked: 4 }), { name: 'park' }).refused.code, 'OUTBOX_NOTHING_TO_PARK');
  assert.equal(run(snap({ state: 'applied', remade: 1, receipted: 2 }), { name: 'write' }).refused.code, 'OUTBOX_TAIL_UNMADE');
  assert.equal(run(snap({ state: 'remade', remade: 2, receipted: 2 }), { name: 'remake' }).refused.code, 'OUTBOX_ILLEGAL_MOVE');
});

test('moves.outbox.explain-reads-the-outbox-table-in: explain reads the outbox table in order from the rule words its guards run [C7,#6729]', () => {
  const explained = explainTable(OUTBOX_TABLE, OUTBOX_RULES);
  assert.equal(explained.guards.find(guard => guard.code === 'OUTBOX_BEHIND').says, OUTBOX_RULES.takeable.says);
  assert.deepEqual(explained.outcomes.map(outcome => outcome.id), ['queue', 'send', 'acknowledge', 'park', 'recover', 'take', 'apply', 'remake', 'write', 'resume', 'fallback']);
});

/** A case per move from a state that allows it, with breaks that fail the guards one fact at a time. */
function generate(g) {
  const name = g.pick(OUTBOX_MOVES);
  const moves = 3 + g.int(4);
  const base = { state: 'queued', baseSequence: 10, moves, sent: 0, receipted: 0, parked: 0, remade: 0 };
  const own = { snapshot: { outbox: base, board: { sequence: 10 } }, move: { name } };
  if (name === 'queue') return { ...own, breaks: { legalFromState: (s, m) => ({ snapshot: { ...s, outbox: { ...s.outbox, state: 'undone' } }, move: m }) } };
  if (name === 'send') return { ...own, breaks: { sendable: (s, m) => ({ snapshot: { ...s, outbox: { ...s.outbox, sent: moves } }, move: m }) } };
  if (name === 'acknowledge') return { snapshot: { outbox: { ...base, state: 'sent', sent: moves, receipted: 1 }, board: { sequence: 10 } }, move: { name }, breaks: { ackable: (s, m) => ({ snapshot: { ...s, outbox: { ...s.outbox, receipted: moves } }, move: m }) } };
  if (name === 'park') return { ...own, breaks: { parkable: (s, m) => ({ snapshot: { ...s, outbox: { ...s.outbox, parked: moves } }, move: m }) } };
  if (name === 'recover') return { snapshot: { outbox: { ...base, state: 'parked', parked: moves }, board: { sequence: 10 } }, move: { name } };
  if (name === 'takeBack') return { ...own, breaks: { takeable: (s, m) => ({ snapshot: { ...s, board: { sequence: 12 } }, move: m }) } };
  if (name === 'apply') return { snapshot: { outbox: { ...base, state: 'undone' }, board: { sequence: 10 } }, move: { name, sequence: 12, receipted: 2 } };
  if (name === 'remake') return { snapshot: { outbox: { ...base, state: 'applied', receipted: 1 }, board: { sequence: 12 } }, move: { name }, breaks: { remakable: (s, m) => ({ snapshot: { ...s, outbox: { ...s.outbox, remade: moves } }, move: m }) } };
  if (name === 'write') return { snapshot: { outbox: { ...base, state: 'remade', receipted: 1, remade: moves - 1 }, board: { sequence: 12 } }, move: { name }, breaks: { writable: (s, m) => ({ snapshot: { ...s, outbox: { ...s.outbox, remade: 0 } }, move: m }) } };
  if (name === 'resume') return { snapshot: { outbox: { ...base, state: g.pick(['undone', 'applied', 'remade', 'sent']), receipted: 1, remade: 1 }, board: { sequence: 12 } }, move: { name }, breaks: { resumable: (s, m) => ({ snapshot: { outbox: { ...s.outbox, state: 'queued' }, board: { sequence: 10 } }, move: m }) } };
  return { ...own, move: { name, checkpoint: 11 }, breaks: { fallbackable: (s, m) => ({ snapshot: s, move: { ...m, checkpoint: 3 } }) } };
}

test('moves.outbox.generated-cases-reach-every-outbox-row: generated cases reach every outbox row, never write while refusing, and fail each guard when its fact is broken [C7,#6729]', () => {
  const report = tableCases(OUTBOX_TABLE, OUTBOX_RULES, generate, { seed: 6729, count: 800 });
  assert.deepEqual(report.writingRefusals, []);
  assert.deepEqual(report.unbroken, []);
  assert.deepEqual(report.unreached.outcomes, []);
});

/**
 * One rebuild pass over a model of what is real: the relay acknowledged the first `acknowledged` tail moves, `board` is the applied sequence.
 * `stopAfter` is the step after which the process dies (0 = before any step); a restart begins with resume when the table says the outbox is stranded.
 */
function pass(model, stopAfter) {
  const { relay, real } = model;
  const step = (name, extra) => {
    const answer = model.send({ name, ...extra });
    assert.ok(!answer.refused, `${name} is legal from ${model.state.outbox.state}: ${answer.refused?.code}`);
    return answer;
  };
  const was = model.state.outbox.state;
  const stranded = !model.send({ name: 'resume' }).refused;
  // Resuming from a taken-back tail runs the apply step for real: the relay's records go onto the board once.
  if (stranded && was === 'undone') { real.board += 2; real.applied += relay.acknowledged; model.board(real.board); }
  if (stranded) { if (['none', 'queued'].includes(model.state.outbox.state) && model.state.outbox.baseSequence === model.state.board.sequence) real.rebuilt = true; return; }
  let done = 0;
  const stop = () => stopAfter === done++;
  if (stop()) return;
  step('takeBack');
  real.onBoard.clear();
  if (stop()) return;
  real.board += 2;
  real.applied += relay.acknowledged;
  model.board(real.board);
  step('apply', { sequence: real.board, receipted: relay.acknowledged });
  if (stop()) return;
  while (model.state.outbox.state === 'applied') step('remake');
  if (stop()) return;
  step('write');
  model.real.rebuilt = true;
}

/** The tail's own model: ids in order, what the relay acknowledged, and what the board really holds. */
function simulate(seed) {
  const ids = Array.from({ length: 3 + seeded(seed).int(5) }, (_, index) => `m${index}`);
  let state = { outbox: { state: 'queued', baseSequence: 10, moves: ids.length, sent: 0, receipted: 0, parked: 0, remade: 0 }, board: { sequence: 10 } };
  return {
    ids,
    relay: { acknowledged: 0 },
    real: { board: 10, applied: 0, onBoard: new Set(ids) },
    board: (sequence) => { state = { ...state, board: { sequence } }; },
    send(move) {
      const answer = run(state, move);
      if (!answer.refused) state = { ...state, ...answer.patch };
      else assert.ok(!('patch' in answer));
      return answer;
    },
    get state() { return state; },
  };
}

test('moves.outbox.a-rebuild-stopped-after-any-step: a rebuild stopped after any step is finished by resume: acknowledged moves apply once and the unsent tail keeps its count [C7,#6728]', () => {
  const stops = new Set();
  for (let seed = 1; seed <= 300; seed++) {
    const g = seeded(seed);
    const model = simulate(seed);
    model.relay.acknowledged = g.int(model.ids.length + 1);
    model.send({ name: 'send', count: model.ids.length });
    if (model.relay.acknowledged) model.send({ name: 'acknowledge', count: model.relay.acknowledged });
    const stopAfter = g.int(5);
    stops.add(stopAfter);
    pass(model, stopAfter);
    // Every later restart finishes it, whichever way it was stopped, and never twice.
    for (let restart = 0; restart < 6 && !model.real.rebuilt; restart++) pass(model, 9);
    const left = model.ids.length - model.relay.acknowledged;
    assert.equal(model.state.outbox.moves, left, `the tail is what the relay did not acknowledge (seed ${seed}, stop ${stopAfter})`);
    assert.equal(model.state.outbox.state, left ? 'queued' : 'none');
    assert.equal(model.state.outbox.baseSequence, model.state.board.sequence, 'the base catches up to the board');
    assert.equal(model.real.applied, model.relay.acknowledged, 'acknowledged moves applied once');
  }
  assert.deepEqual([...stops].sort(), [0, 1, 2, 3, 4]);
});

test('moves.outbox.a-move-queued-onto-an-all: clause 1: a move queued onto an all-parked outbox leaves it queued, as the writer records it [C7,#8436]', () => {
  // The writer (outboxCounts) reads an outbox as parked only when every move is parked; a new unparked move makes it queued, and parked means refused for good while later moves keep flowing (docs/api.md).
  const answer = run(snap({ state: 'parked', moves: 2, parked: 2 }), { name: 'queue' });
  assert.deepEqual([answer.patch.outbox.state, answer.patch.outbox.moves, answer.patch.outbox.parked], ['queued', 3, 2]);
  assert.equal(run(snap({ state: 'none', moves: 0 }), { name: 'queue' }).patch.outbox.state, 'queued');
  assert.equal(run(snap({ state: 'sent', sent: 1 }), { name: 'queue' }).patch.outbox.state, 'sent');
});
